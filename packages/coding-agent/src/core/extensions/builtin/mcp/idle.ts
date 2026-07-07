import type { McpServerConfig } from "./config-schema.ts";
import type { ServerConnection } from "./connection.ts";
import type { McpLogger } from "./log.ts";
import { safeInterval, safeTimer } from "./wrap.ts";

export const MCP_KEEP_ALIVE_INTERVAL_MS = 30_000;

interface McpLifecycleState {
	readonly connection: ServerConnection;
	readonly config: McpServerConfig;
	readonly logger: McpLogger;
	readonly unsubscribeState: () => void;
	inFlight: number;
	idleTimer: NodeJS.Timeout | undefined;
	keepAliveTimer: NodeJS.Timeout | undefined;
}

interface McpLifecycleDebugSnapshot {
	inFlight: number;
	idleTimerHasRef: boolean | null;
	keepAliveTimerHasRef: boolean | null;
}

const lifecycleByConnection = new WeakMap<ServerConnection, McpLifecycleState>();

export function configureMcpConnectionLifecycle(
	connection: ServerConnection,
	config: McpServerConfig,
	logger: McpLogger,
): void {
	disposeMcpConnectionLifecycle(connection);
	const state: McpLifecycleState = {
		config,
		connection,
		idleTimer: undefined,
		inFlight: 0,
		keepAliveTimer: undefined,
		logger,
		unsubscribeState: connection.onStateChange(() => {
			refreshLifecycleTimers(state);
		}),
	};
	lifecycleByConnection.set(connection, state);
	refreshLifecycleTimers(state);
}

export function disposeMcpConnectionLifecycle(connection: ServerConnection): void {
	const state = lifecycleByConnection.get(connection);
	if (state === undefined) return;
	lifecycleByConnection.delete(connection);
	clearLifecycleTimer(state, "idleTimer");
	clearLifecycleTimer(state, "keepAliveTimer");
	state.unsubscribeState();
}

export async function runMcpConnectionLifecycleCall<T>(connection: ServerConnection, fn: () => Promise<T>): Promise<T> {
	const state = lifecycleByConnection.get(connection);
	if (state === undefined) return fn();
	state.inFlight += 1;
	clearLifecycleTimer(state, "idleTimer");
	try {
		return await fn();
	} finally {
		state.inFlight -= 1;
		refreshLifecycleTimers(state);
	}
}

export function getMcpLifecycleDebugSnapshot(connection: ServerConnection): McpLifecycleDebugSnapshot | undefined {
	const state = lifecycleByConnection.get(connection);
	if (state === undefined) return undefined;
	return {
		inFlight: state.inFlight,
		idleTimerHasRef: hasRef(state.idleTimer),
		keepAliveTimerHasRef: hasRef(state.keepAliveTimer),
	};
}

function refreshLifecycleTimers(state: McpLifecycleState): void {
	if (state.config.lifecycle === "keep-alive") {
		clearLifecycleTimer(state, "idleTimer");
		if (state.keepAliveTimer === undefined) startKeepAliveTimer(state);
		return;
	}
	clearLifecycleTimer(state, "keepAliveTimer");
	if (state.connection.state !== "connected" || state.inFlight > 0) {
		clearLifecycleTimer(state, "idleTimer");
		return;
	}
	if (state.idleTimer === undefined) startIdleTimer(state);
}

function startIdleTimer(state: McpLifecycleState): void {
	state.idleTimer = safeTimer(
		`mcp.${state.connection.serverName}.idle`,
		state.config.idleTimeoutMin * 60_000,
		async () => {
			state.idleTimer = undefined;
			if (state.connection.state !== "connected") return;
			if (state.inFlight > 0) {
				refreshLifecycleTimers(state);
				return;
			}
			await state.connection.bumpGeneration();
		},
		{ logger: state.logger },
	);
}

function startKeepAliveTimer(state: McpLifecycleState): void {
	state.keepAliveTimer = safeInterval(
		`mcp.${state.connection.serverName}.keepAlive`,
		MCP_KEEP_ALIVE_INTERVAL_MS,
		async () => {
			await runMcpConnectionLifecycleCall(state.connection, () => keepAlivePingOrRecover(state));
		},
		{ logger: state.logger },
	);
}

async function keepAlivePingOrRecover(state: McpLifecycleState): Promise<void> {
	try {
		if (state.connection.state === "connected") {
			await state.connection.client.ping({ timeout: 2_000 });
			return;
		}
		if (state.connection.state === "idle" || state.connection.state === "connecting") {
			await state.connection.connect();
			return;
		}
		await state.connection.renew();
	} catch (error) {
		const normalized = error instanceof Error ? error : new Error(String(error));
		state.connection.markDegraded(normalized);
	}
}

function clearLifecycleTimer(state: McpLifecycleState, key: "idleTimer" | "keepAliveTimer"): void {
	const timer = state[key];
	if (timer === undefined) return;
	clearTimeout(timer);
	state[key] = undefined;
}

function hasRef(timer: NodeJS.Timeout | undefined): boolean | null {
	return timer === undefined ? null : timer.hasRef();
}
