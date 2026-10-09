/**
 * The lifecycle supervisor's policy half: which cold-start mode and idle-exit window apply
 * (`resolveHostPolicy`, environment over settings.json over the defaults), and the pure decision
 * core that turns the current activity snapshot into active / idle / exit (`IdleExitDecider`).
 *
 * Nothing here touches a socket, a process or the filesystem; `host-lifecycle.ts` owns all of that
 * and re-exports these names so every existing importer keeps resolving them at their original home.
 */
export type HostColdStart = "transient" | "persistent";

/** Environment override for the cold-start policy: `transient` or `persistent`. */
export const HOST_COLD_START_ENV = "SENPI_RPC_HOST_COLD_START";
/** Environment override for the idle-exit window in milliseconds. */
export const HOST_IDLE_EXIT_MS_ENV = "SENPI_RPC_HOST_IDLE_EXIT_MS";
/** Default idle-exit window: 15 minutes of continuous no-connection, no-turn idle. */
export const DEFAULT_HOST_IDLE_EXIT_MS = 15 * 60_000;
/** Soft handoff deadline: rescan and report, never interrupt turns or in-flight requests. */
export const HANDOFF_GRACE_MS_ENV = "SENPI_RPC_HANDOFF_GRACE_MS";
export const DEFAULT_HANDOFF_GRACE_MS = 10 * 60_000;

/** The policy fields ensureHost() records in rpc-host-daemon/settings.json. */
export interface HostLifecyclePolicyInput {
	readonly coldStart?: HostColdStart;
	readonly idleExitMs?: number;
}

export interface HostLifecyclePolicy {
	readonly coldStart: HostColdStart;
	readonly idleExitMs: number;
}

export function parseColdStart(value: string | undefined): HostColdStart | undefined {
	return value === "transient" || value === "persistent" ? value : undefined;
}

export function parseIdleExitMs(value: string | undefined): number | undefined {
	if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
	const parsed = Number(value.trim());
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Resolves the effective host policy. Precedence: environment overrides beat
 * settings.json, which beats the documented defaults (transient, 15 minutes).
 * Invalid values at either source fall through to the next source.
 */
export function resolveHostPolicy(
	settings: unknown,
	env: Readonly<Record<string, string | undefined>>,
): HostLifecyclePolicy {
	const record = isRecord(settings) ? settings : {};
	const coldStart =
		parseColdStart(env[HOST_COLD_START_ENV]) ?? parseColdStart(asOptionalString(record.coldStart)) ?? "transient";
	const idleExitMs =
		parseIdleExitMs(env[HOST_IDLE_EXIT_MS_ENV]) ??
		parseIdleExitMs(asOptionalString(record.idleExitMs)) ??
		DEFAULT_HOST_IDLE_EXIT_MS;
	return { coldStart, idleExitMs };
}

export interface HostActivity {
	readonly connections: number;
	readonly activeTurns: number;
}

export type IdleExitDecision = "active" | "idle" | "exit";

/**
 * Pure idle-window decision core. `update()` must be called with the CURRENT
 * activity state; the window only counts continuously idle time and any
 * activity resets it, so a busy host can never cross the threshold.
 */
export class IdleExitDecider {
	private idleSince: number | undefined;
	private readonly now: () => number;
	readonly idleExitMs: number;

	constructor(idleExitMs: number, now: () => number = Date.now) {
		this.idleExitMs = idleExitMs;
		this.now = now;
	}

	update(activity: HostActivity): IdleExitDecision {
		// Any attachment or active turn both holds the host open and resets the
		// window, so only CONTINUOUS idle can ever cross the threshold.
		if (activity.connections > 0 || activity.activeTurns > 0) {
			this.idleSince = undefined;
			return "active";
		}
		if (this.idleExitMs === Number.POSITIVE_INFINITY) return "idle";
		if (this.idleSince === undefined) {
			this.idleSince = this.now();
			return "idle";
		}
		return this.now() - this.idleSince >= this.idleExitMs ? "exit" : "idle";
	}
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asOptionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
}
