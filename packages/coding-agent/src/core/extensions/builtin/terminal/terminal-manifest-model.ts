/**
 * The terminal manifest's data model: the durable per-session record of live monitors and
 * background sessions that `restore.ts` strict-parses back after a restart. Types and the
 * constants that govern them live here; all runtime behaviour is in `terminal-manifest.ts`.
 */

import type { SessionManager } from "../../../session-manager.ts";

export const TERMINAL_MANIFEST_VERSION = 1;
/** Minimum debounce for checkpoint writes; a burst inside this window collapses to one write. */
export const TERMINAL_MANIFEST_CHECKPOINT_DEBOUNCE_MS = 30_000;
/**
 * Re-exported so manifest consumers read one durability deadline. The value lives in
 * `shared.ts` with the rest of the terminal caps; there is exactly one definition of it.
 */
export { DURABLE_MONITOR_EXPIRY_MS } from "./shared.ts";
export type TerminalManifestSession = Pick<SessionManager, "getSessionDir" | "getSessionId">;
export type MonitorRuntimeKind = "command" | "file";
export type MonitorDurabilityClass = "ephemeral" | "restartable-command" | "checkpointed-file";
/**
 * File-monitor checkpoint persisted by the writer: the registry's live identity tuple. `digest`
 * is required — without it a same-size, same-mtime rewrite is undetectable across a restart.
 */
export interface TerminalManifestCheckpoint {
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	readonly mtimeMs: number;
	readonly digest: string;
	readonly present: boolean;
}

export interface ManifestMonitor {
	readonly monitorId: string;
	/** Owning agent session id — never the bash_N/watch_N runtime id. */
	readonly sessionId: string;
	readonly description: string;
	readonly runtimeKind: MonitorRuntimeKind;
	readonly durabilityClass: MonitorDurabilityClass;
	readonly command?: string;
	readonly path?: string;
	readonly event?: "create" | "modify";
	readonly filter?: string;
	readonly cwd?: string;
	readonly approvedParent?: string;
	readonly createdAt: number;
	readonly expiresAt: number | null;
	readonly persistent: boolean;
	readonly suspended: boolean;
	readonly lastCheckpoint: TerminalManifestCheckpoint | null;
	readonly deliveryPaused: boolean;
	readonly fireWindow: { startMs: number; count: number };
}

export interface ManifestBackgroundSession {
	readonly id: string;
	readonly command: string;
	readonly startedAtMs: number;
}

export interface TerminalManifest {
	readonly version: typeof TERMINAL_MANIFEST_VERSION;
	readonly sessionId: string;
	readonly monitors: readonly ManifestMonitor[];
	readonly backgroundSessions: readonly ManifestBackgroundSession[];
	readonly updatedAt: number;
}

/** What the monitor tool captures at its call site — the only place the branch inputs live. */
export interface CommandMonitorSpec {
	readonly kind: "command";
	readonly description: string;
	readonly command: string;
	readonly filter?: string;
	readonly cwd?: string;
	readonly persistent: boolean;
}

export interface FileMonitorSpec {
	readonly kind: "file";
	readonly description: string;
	readonly path: string;
	readonly event: "create" | "modify";
	readonly timeoutMs: number;
	readonly cwd: string;
	readonly approvedParent?: string;
	/** Persistent file watches are the durable `checkpointed-file` class; one-shot ones stay ephemeral. */
	readonly persistent: boolean;
}
export type MonitorSpec = CommandMonitorSpec | FileMonitorSpec;

export interface MonitorRegistration {
	readonly monitorId: string;
	readonly spec: MonitorSpec;
}
