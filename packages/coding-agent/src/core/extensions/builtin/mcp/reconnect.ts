import type { ServerConnection } from "./connection.ts";
import { ConnectError } from "./errors.ts";
import type { McpLogger } from "./log.ts";
import { safeTimer } from "./wrap.ts";

export const MCP_RECONNECT_BACKOFF_MS = [500, 1000, 2000, 4000, 8000] as const;
export const MCP_RECONNECT_BREAKER_WINDOW_MS = 30_000;
export const MCP_RECONNECT_BREAKER_ATTEMPTS = 5;
/** How long dispose waits for reconnect attempts that are still running before it detaches them (senpi#4642). */
export const MCP_RECONNECT_DISPOSE_WAIT_MS = 2_000;

interface McpReconnectOptions {
	readonly connection: ServerConnection;
	readonly logger: McpLogger;
	/** Runs one attempt; `signal` aborts when the reconnect is disposed, so slow work (an OAuth refresh) stops then. */
	readonly reconnect: (signal: AbortSignal) => Promise<void>;
	readonly shouldReconnect?: () => boolean;
	readonly random?: () => number;
}

interface McpReconnectState {
	readonly connection: ServerConnection;
	readonly logger: McpLogger;
	readonly reconnect: (signal: AbortSignal) => Promise<void>;
	readonly shouldReconnect: () => boolean;
	readonly random: () => number;
	readonly unsubscribe: () => void;
	attemptTimes: number[];
	backoffIndex: number;
	disposed: boolean;
	timer: NodeJS.Timeout | undefined;
	timerGeneration: number | undefined;
	/** Aborted by dispose; every attempt gets its signal. */
	readonly abort: AbortController;
	/** Every attempt running now (a manual reconnect can overlap a timer attempt); dispose awaits them, bounded. */
	readonly inflight: Set<Promise<void>>;
}

const reconnectStates = new WeakMap<ServerConnection, McpReconnectState>();

export function configureMcpReconnect(options: McpReconnectOptions): void {
	// A reconfigure (a second attach of the same connection) is not a teardown: attempts the previous state started
	// keep running under the new state, which inherits their abort signal and in-flight set (senpi#4642).
	const previous = retireMcpReconnect(options.connection);
	const state: McpReconnectState = {
		attemptTimes: [],
		backoffIndex: 0,
		connection: options.connection,
		disposed: false,
		logger: options.logger,
		random: options.random ?? Math.random,
		reconnect: options.reconnect,
		shouldReconnect: options.shouldReconnect ?? (() => true),
		timer: undefined,
		timerGeneration: undefined,
		abort: previous?.state.abort ?? new AbortController(),
		inflight: previous?.state.inflight ?? new Set(),
		unsubscribe: options.connection.onStateChange((event) => {
			if (event.state === "degraded") scheduleReconnect(state, event.generation, event.error);
			if (event.state === "connected") state.backoffIndex = 0;
		}),
	};
	reconnectStates.set(options.connection, state);
	// A reconnect the previous state had waiting on its backoff timer is not dropped by the reconfigure.
	if (previous?.hadTimer === true)
		scheduleReconnect(state, options.connection.generation, options.connection.lastError);
}

/** Takes the previous state off the connection without aborting its attempts; reports a pending backoff timer. */
function retireMcpReconnect(
	connection: ServerConnection,
): { readonly state: McpReconnectState; readonly hadTimer: boolean } | undefined {
	const state = reconnectStates.get(connection);
	if (state === undefined) return undefined;
	reconnectStates.delete(connection);
	state.unsubscribe();
	const hadTimer = state.timer !== undefined;
	clearReconnectTimer(state);
	return { state, hadTimer };
}

/**
 * Stops reconnecting: a reconnect still waiting on its backoff timer never starts, none is scheduled later, and
 * every attempt already running is aborted (its OAuth refresh included). The returned promise settles once those
 * attempts have settled, or after `waitMs` at the latest: dispose stays bounded. An attempt still running then is
 * detached; it marks and reschedules nothing, and an OAuth refresh past its token request finishes and persists
 * the rotated tokens (senpi#4642).
 */
export function disposeMcpReconnect(
	connection: ServerConnection,
	waitMs = MCP_RECONNECT_DISPOSE_WAIT_MS,
): Promise<void> {
	const state = reconnectStates.get(connection);
	if (state === undefined) return Promise.resolve();
	reconnectStates.delete(connection);
	state.disposed = true;
	clearReconnectTimer(state);
	state.unsubscribe();
	state.abort.abort();
	if (state.inflight.size === 0) return Promise.resolve();
	return settledWithin(
		Promise.all(state.inflight).then(() => undefined),
		waitMs,
	);
}

function settledWithin(work: Promise<void>, waitMs: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, waitMs);
		timer.unref?.();
		void work.then(() => {
			clearTimeout(timer);
			resolve();
		});
	});
}

export async function reconnectMcpNow(connection: ServerConnection): Promise<void> {
	const state = reconnectStates.get(connection);
	if (state === undefined) {
		await connection.renew();
		return;
	}
	clearReconnectTimer(state);
	state.attemptTimes = [];
	state.backoffIndex = 0;
	await runReconnectAttempt(state, connection.generation, true);
}

export function getMcpReconnectDebugSnapshot(connection: ServerConnection): {
	attemptsInWindow: number;
	timerHasRef: boolean | null;
} {
	const state = reconnectStates.get(connection);
	if (state === undefined) return { attemptsInWindow: 0, timerHasRef: null };
	return {
		attemptsInWindow: pruneAttemptTimes(state, Date.now()).length,
		timerHasRef: state.timer?.hasRef() ?? null,
	};
}

function scheduleReconnect(state: McpReconnectState, generation: number, cause: Error | undefined): void {
	if (state.disposed || state.timer !== undefined || !state.shouldReconnect()) return;
	if (state.connection.state === "disabled" || state.connection.state === "suspended") return;
	if (breakerShouldOpen(state, Date.now())) {
		openCircuit(state, cause);
		return;
	}
	const baseDelayMs = MCP_RECONNECT_BACKOFF_MS[Math.min(state.backoffIndex, MCP_RECONNECT_BACKOFF_MS.length - 1)];
	const delayMs = Math.max(0, Math.floor(baseDelayMs * clampRandom(state.random())));
	state.timerGeneration = generation;
	state.timer = safeTimer(
		`mcp.${state.connection.serverName}.reconnect`,
		delayMs,
		async () => {
			state.timer = undefined;
			const timerGeneration = state.timerGeneration;
			state.timerGeneration = undefined;
			if (timerGeneration === undefined) return;
			await runReconnectAttempt(state, timerGeneration, false);
		},
		{ logger: state.logger },
	);
}

async function runReconnectAttempt(state: McpReconnectState, generation: number, manual: boolean): Promise<void> {
	const attempt = attemptReconnect(state, generation, manual);
	const tracked = attempt.then(
		() => undefined,
		() => undefined,
	);
	state.inflight.add(tracked);
	try {
		await attempt;
	} finally {
		state.inflight.delete(tracked);
	}
}

async function attemptReconnect(state: McpReconnectState, generation: number, manual: boolean): Promise<void> {
	if (state.disposed || !state.shouldReconnect()) return;
	if (!manual && generation !== state.connection.generation) return;
	if (state.connection.state === "disabled") return;
	if (!manual && breakerShouldOpen(state, Date.now())) {
		openCircuit(state);
		return;
	}
	state.attemptTimes = [...pruneAttemptTimes(state, Date.now()), Date.now()];
	state.backoffIndex += 1;
	try {
		await state.reconnect(state.abort.signal);
		state.backoffIndex = 0;
	} catch (error) {
		const failure = error instanceof Error ? error : new Error(String(error));
		// The state now responsible for this connection: this one, or the one a reconfigure handed it to.
		const live = reconnectStates.get(state.connection);
		// An attempt that dispose overtook is not a server failure: nothing is marked or rescheduled.
		if (live === undefined || live.disposed) return throwIfManual(manual, failure);
		if (live.connection.state !== "suspended" && live.connection.state !== "needs_auth") {
			const visibleFailure =
				isGenericReconnectFailure(failure) && live.connection.lastError !== undefined
					? live.connection.lastError
					: failure;
			live.connection.markDegraded(visibleFailure);
			scheduleReconnect(live, live.connection.generation, visibleFailure);
		}
		throwIfManual(manual, failure);
	}
}

function isGenericReconnectFailure(error: Error): boolean {
	return error.message.includes("connect was superseded") || error.message.includes("transport closed");
}

function breakerShouldOpen(state: McpReconnectState, now: number): boolean {
	state.attemptTimes = pruneAttemptTimes(state, now);
	return state.attemptTimes.length >= MCP_RECONNECT_BREAKER_ATTEMPTS;
}

function openCircuit(state: McpReconnectState, cause?: Error): void {
	clearReconnectTimer(state);
	state.connection.markSuspended(
		new ConnectError(
			`MCP server ${state.connection.serverName} reconnect circuit breaker opened after ${MCP_RECONNECT_BREAKER_ATTEMPTS} attempts in ${MCP_RECONNECT_BREAKER_WINDOW_MS / 1000}s; run /mcp reconnect ${state.connection.serverName}`,
			{ cause, phase: "reconnect", retriable: false, serverName: state.connection.serverName },
		),
	);
}

function pruneAttemptTimes(state: McpReconnectState, now: number): number[] {
	return state.attemptTimes.filter((attemptAt) => now - attemptAt <= MCP_RECONNECT_BREAKER_WINDOW_MS);
}

function clearReconnectTimer(state: McpReconnectState): void {
	if (state.timer === undefined) return;
	clearTimeout(state.timer);
	state.timer = undefined;
	state.timerGeneration = undefined;
}

function clampRandom(random: number): number {
	if (!Number.isFinite(random)) return 1;
	if (random < 0) return 0;
	if (random > 1) return 1;
	return random;
}

function throwIfManual(manual: boolean, error: Error): void {
	if (manual) throw error;
}
