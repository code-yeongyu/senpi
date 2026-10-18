import { parseIdleExitMs } from "./host-lifecycle-policy.ts";

/**
 * The stall threshold the host's loop-lag watchdog judges by, and that every reader of its evidence
 * (an ensure, the supervisor's stop) judges by too. A leaf on purpose: the supervisor needs this one
 * number, and importing the watchdog for it would put the in-host session-attribution machinery in
 * the supervisor's import graph.
 */

/** Environment override for the drift that also emits `host_stalled`, in milliseconds. */
export const LOOP_LAG_ERROR_MS_ENV = "SENPI_RPC_LOOP_LAG_ERROR_MS";
export const DEFAULT_LOOP_LAG_ERROR_MS = 5_000;

/** The drift past which a tick is a stall, as the host itself judges it. Readers of its evidence use the same. */
export function loopLagErrorMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
	return parseIdleExitMs(env[LOOP_LAG_ERROR_MS_ENV]) ?? DEFAULT_LOOP_LAG_ERROR_MS;
}
