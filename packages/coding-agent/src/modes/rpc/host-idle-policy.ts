import { parseIdleExitMs } from "./host-lifecycle.ts";

/** Environment override for the idle-session eviction window, in milliseconds. */
export const RPC_SESSION_IDLE_EVICTION_MS_ENV = "SENPI_RPC_SESSION_IDLE_EVICTION_MS";
/** Environment override for the empty-host exit window, in milliseconds. */
export const RPC_HOST_EMPTY_EXIT_MS_ENV = "SENPI_RPC_HOST_EMPTY_EXIT_MS";
/** Environment override for the graceful close_session teardown window, in milliseconds. */
export const RPC_CLOSE_GRACE_MS_ENV = "SENPI_RPC_CLOSE_GRACE_MS";
/** Default idle-eviction window: 30 minutes after a session's last routed command or settled turn. */
export const DEFAULT_SESSION_IDLE_EVICTION_MS = 30 * 60_000;
/** Default empty-host exit: 15 minutes with zero open sessions, matching the supervisor's idle window. */
export const DEFAULT_HOST_EMPTY_EXIT_MS = 15 * 60_000;

/** Explicit occupancy-policy overrides for createHostCore; tests inject clocks and hooks here. */
export interface HostIdleOverrides {
	now?: () => number;
	idleEvictionMs?: number;
	emptyExitMs?: number;
	closeGraceMs?: number;
	/** Shutdown hook the empty-exit window invokes; hosts pass their exit path. */
	onEmptyExit?: () => void;
	onHandoffParked?: (connections: readonly string[]) => Promise<void>;
	/** Gate consulted before the empty-exit window advances (connected clients block it). */
	canExitWhenEmpty?: () => boolean;
}

export function resolveHostIdlePolicy(
	env: Readonly<Record<string, string | undefined>>,
	overrides: HostIdleOverrides = {},
): { now: () => number; idleEvictionMs: number; emptyExitMs: number } {
	return {
		now: overrides.now ?? Date.now,
		idleEvictionMs:
			overrides.idleEvictionMs ??
			parseIdleExitMs(env[RPC_SESSION_IDLE_EVICTION_MS_ENV]) ??
			DEFAULT_SESSION_IDLE_EVICTION_MS,
		emptyExitMs:
			overrides.emptyExitMs ?? parseIdleExitMs(env[RPC_HOST_EMPTY_EXIT_MS_ENV]) ?? DEFAULT_HOST_EMPTY_EXIT_MS,
	};
}
