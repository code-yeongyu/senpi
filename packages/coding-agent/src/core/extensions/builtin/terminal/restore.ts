/**
 * The restore orchestrator: `restoreTerminalState` replays the manifest after a restart. Every
 * monitor is classified up front (expired, ephemeral with or without time left, durable) and the
 * durable and still-live ephemeral ones are handed to their kind's handler, all concurrently.
 * The result carries per-monitor outcomes and reasons, background sessions told apart as still
 * running or exited, and an upper bound on how long the session was detached.
 */

import type { SidecarStore } from "../../../session-sidecar-store.ts";
import { confirmOwner } from "./orphan-reaper.ts";
import type { ChildProcessIdentity } from "./process-identity.ts";
import { sessionActivityBeforeMs } from "./session-activity.ts";
import type { ManifestBackgroundSession, ManifestMonitor, TerminalManifest } from "./terminal-manifest.ts";

export { InvalidTerminalManifestError, parseTerminalManifest } from "./terminal-manifest-parse.ts";

export type RestoreOutcome = "restored" | "lost" | "muted" | "completed" | "attachedElsewhere";

export interface RestoreHandlerResult {
	readonly outcome: RestoreOutcome;
	/** Why a monitor could not come back (or what its restore did), shown per monitor in the digest. */
	readonly reason?: string;
	/** The watcher a crash left running: killed before the respawn, or left alone when unverifiable. */
	readonly orphan?: { readonly pid: number; readonly action: "killed" | "unverified" };
	/** The re-spawned process, so the manifest can find it after the next crash. */
	readonly runtime?: ChildProcessIdentity;
}

export interface RestoreContext {
	/** Upper bound on how long the session was detached (never an exact gap). */
	readonly downtimeMs: number;
	/** Time left for an ephemeral watch whose deadline has not passed; undefined for durable ones. */
	readonly remainingMs?: number;
}

export type RestoreHandler = (
	monitor: ManifestMonitor,
	context: RestoreContext,
) => RestoreHandlerResult | Promise<RestoreHandlerResult>;

export interface RestoreHandlers {
	readonly "restartable-command": RestoreHandler;
	readonly "checkpointed-file": RestoreHandler;
}

/** The registry surface a restore handler needs to re-apply a persisted mute. */
export interface PersistedMuteRegistry {
	pause(ids: readonly string[]): string[];
}

/**
 * Re-apply a persisted `deliveryPaused` mute to a freshly restored monitor and report the
 * outcome it contributes to the digest. The mute MUST be applied by the FRESH runtime id
 * (bash_N/watch_N) the restore just allocated: `MonitorRegistry.pause` resolves records by
 * runtime id only, so passing the persisted `mon_` id silently no-ops and the mute is lost.
 */
export function reapplyPersistedMute(
	registry: PersistedMuteRegistry,
	monitor: Pick<ManifestMonitor, "deliveryPaused">,
	runtimeId: string,
): RestoreOutcome {
	if (!monitor.deliveryPaused) return "restored";
	registry.pause([runtimeId]);
	return "muted";
}

/** Stub handlers: every monitor is reported lost until a caller plugs the real ones in. */
export const stubRestoreHandlers: RestoreHandlers = {
	"restartable-command": () => ({ outcome: "lost", reason: "no restore handler" }),
	"checkpointed-file": () => ({ outcome: "lost", reason: "no restore handler" }),
};

export type MonitorRestoreOutcome = RestoreOutcome | "expired";

export interface MonitorRestoreResult {
	readonly monitorId: string;
	readonly description: string;
	readonly kind: ManifestMonitor["runtimeKind"];
	readonly outcome: MonitorRestoreOutcome;
	readonly command?: string;
	readonly path?: string;
	readonly reason?: string;
	readonly orphan?: RestoreHandlerResult["orphan"];
}

export interface BackgroundRestoreResult {
	readonly id: string;
	readonly command: string;
	readonly outcome: "running" | "exited";
	readonly pid?: number;
}

export interface RestoreDigest {
	restored: number;
	lost: number;
	expired: number;
	muted: number;
	completed: number;
	attachedElsewhere: number;
	storeError: boolean;
	readonly results: readonly MonitorRestoreResult[];
	readonly backgroundSessions: readonly BackgroundRestoreResult[];
	/** Upper bound on how long the session was detached; 0 when nothing was persisted. */
	readonly downtimeMs: number;
}

export interface RestoreTerminalStateOptions {
	readonly manifest: SidecarStore<TerminalManifest>;
	readonly handlers?: Partial<RestoreHandlers>;
	readonly now?: () => number;
	/** The session transcript; its last entry written before this process started bounds the downtime. */
	readonly sessionFile?: string;
	readonly processStartedAtMs?: number;
	readonly isBackgroundAlive?: (session: ManifestBackgroundSession) => Promise<boolean>;
}

function emptyDigest(): RestoreDigest {
	return {
		restored: 0,
		lost: 0,
		expired: 0,
		muted: 0,
		completed: 0,
		attachedElsewhere: 0,
		storeError: false,
		results: [],
		backgroundSessions: [],
		downtimeMs: 0,
	};
}

async function defaultBackgroundAlive(session: ManifestBackgroundSession): Promise<boolean> {
	if (session.runtime === undefined) return false;
	return (await confirmOwner(session.runtime, undefined)) === "confirmed";
}

function resultFor(monitor: ManifestMonitor, outcome: MonitorRestoreOutcome, handled?: RestoreHandlerResult) {
	return {
		monitorId: monitor.monitorId,
		description: monitor.description,
		kind: monitor.runtimeKind,
		outcome,
		...(monitor.command !== undefined ? { command: monitor.command } : {}),
		...(monitor.path !== undefined ? { path: monitor.path } : {}),
		...(handled?.reason !== undefined ? { reason: handled.reason } : {}),
		...(handled?.orphan !== undefined ? { orphan: handled.orphan } : {}),
	} satisfies MonitorRestoreResult;
}

export async function restoreTerminalState(options: RestoreTerminalStateOptions): Promise<RestoreDigest> {
	let state: TerminalManifest | null;
	try {
		state = await options.manifest.read();
	} catch {
		// Fail closed: a corrupt or foreign manifest restores nothing and reports the store error.
		return { ...emptyDigest(), storeError: true };
	}
	if (state === null) return emptyDigest();
	const now = (options.now ?? Date.now)();
	const lastSeen = Math.max(
		state.updatedAt,
		(await sessionActivityBeforeMs(options.sessionFile, options.processStartedAtMs ?? now)) ?? 0,
	);
	const downtimeMs = Math.max(0, now - lastSeen);
	const handlers: RestoreHandlers = { ...stubRestoreHandlers, ...options.handlers };

	const results = await Promise.all(
		state.monitors.map(async (monitor): Promise<MonitorRestoreResult> => {
			// At the deadline the entry is already expired: the handler must not see it at all.
			if (monitor.expiresAt !== null && monitor.expiresAt <= now) return resultFor(monitor, "expired");
			if (monitor.durabilityClass === "ephemeral") {
				if (monitor.deadlineMs === undefined || monitor.deadlineMs <= now) {
					return resultFor(monitor, "lost", { outcome: "lost", reason: "deadline passed while detached" });
				}
				const handler =
					monitor.runtimeKind === "file" ? handlers["checkpointed-file"] : handlers["restartable-command"];
				const handled = await handler(monitor, { downtimeMs, remainingMs: monitor.deadlineMs - now });
				return resultFor(monitor, handled.outcome, handled);
			}
			const handled = await handlers[monitor.durabilityClass](monitor, { downtimeMs });
			return resultFor(monitor, handled.outcome, handled);
		}),
	);

	const isAlive = options.isBackgroundAlive ?? defaultBackgroundAlive;
	const backgroundSessions = await Promise.all(
		state.backgroundSessions.map(async (session): Promise<BackgroundRestoreResult> => {
			if (session.runtime !== undefined && (await isAlive(session))) {
				return { id: session.id, command: session.command, outcome: "running", pid: session.runtime.pid };
			}
			return { id: session.id, command: session.command, outcome: "exited" };
		}),
	);

	const digest = { ...emptyDigest(), results, backgroundSessions, downtimeMs };
	for (const result of results) digest[result.outcome] += 1;
	digest.lost += backgroundSessions.length;
	return digest;
}
