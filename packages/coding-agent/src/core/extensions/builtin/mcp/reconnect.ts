import type { ServerConnection } from "./connection.ts";
import { ConnectError } from "./errors.ts";
import type { McpLogger } from "./log.ts";
import { safeTimer } from "./wrap.ts";

export const MCP_RECONNECT_BACKOFF_MS = [500, 1000, 2000, 4000, 8000] as const;
export const MCP_RECONNECT_BREAKER_WINDOW_MS = 30_000;
export const MCP_RECONNECT_BREAKER_ATTEMPTS = 5;

interface McpReconnectOptions {
	readonly connection: ServerConnection;
	readonly logger: McpLogger;
	readonly reconnect: () => Promise<void>;
	readonly shouldReconnect?: () => boolean;
	readonly random?: () => number;
}

interface McpReconnectState {
	readonly connection: ServerConnection;
	readonly logger: McpLogger;
	readonly reconnect: () => Promise<void>;
	readonly shouldReconnect: () => boolean;
	readonly random: () => number;
	readonly unsubscribe: () => void;
	attemptTimes: number[];
	backoffIndex: number;
	disposed: boolean;
	timer: NodeJS.Timeout | undefined;
	timerGeneration: number | undefined;
}

const reconnectStates = new WeakMap<ServerConnection, McpReconnectState>();

export function configureMcpReconnect(options: McpReconnectOptions): void {
	disposeMcpReconnect(options.connection);
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
		unsubscribe: options.connection.onStateChange((event) => {
			if (event.state === "degraded") scheduleReconnect(state, event.generation, event.error);
			if (event.state === "connected") state.backoffIndex = 0;
		}),
	};
	reconnectStates.set(options.connection, state);
}

export function disposeMcpReconnect(connection: ServerConnection): void {
	const state = reconnectStates.get(connection);
	if (state === undefined) return;
	reconnectStates.delete(connection);
	state.disposed = true;
	clearReconnectTimer(state);
	state.unsubscribe();
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
		await state.reconnect();
		state.backoffIndex = 0;
	} catch (error) {
		const failure = error instanceof Error ? error : new Error(String(error));
		if (state.connection.state !== "suspended") {
			const visibleFailure =
				isSupersededConnectFailure(failure) && state.connection.lastError !== undefined
					? state.connection.lastError
					: failure;
			state.connection.markDegraded(visibleFailure);
			scheduleReconnect(state, state.connection.generation, visibleFailure);
		}
		throwIfManual(manual, failure);
	}
}

function isSupersededConnectFailure(error: Error): boolean {
	return error.message.includes("connect was superseded");
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
