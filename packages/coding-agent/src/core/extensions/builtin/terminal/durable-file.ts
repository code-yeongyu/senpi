/**
 * The `checkpointed-file` durability class: the restore handler that makes a persistent file
 * watch survive a restart. On create the monitor tool persists the registry's own identity
 * tuple (dev/ino/size/mtimeMs/digest/present) as the manifest checkpoint; here that checkpoint
 * is compared ONCE against the file as it is now, and any change that happened while the process
 * was gone is reported as EXACTLY ONE line through the registry's normal event sink — so the
 * notifier's coalescing and wake budget apply to it exactly as they do to a live watch event.
 *
 * `digest` is load-bearing: without it a same-size, same-mtime rewrite is invisible across a restart.
 */

import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { MonitorRegistry } from "./monitor-registry.ts";
import type { RestoreHandler, RestoreHandlerResult } from "./restore.ts";
import type { ManifestMonitor, TerminalManifestCheckpoint, TerminalManifestWriter } from "./terminal-manifest.ts";

/**
 * What a detached change is reported as. `null` means the file is byte-identical to the checkpoint;
 * `"gone"` means it existed at checkpoint time and does not now, which is not restorable.
 */
export type DetachedChange = "created" | "replaced" | "modified" | "gone" | null;

/** Only what the handler needs, so a caller can hand it a narrower registry/writer. */
export interface CheckpointedFileRestoreDeps {
	readonly registry: Pick<MonitorRegistry, "registerFile" | "fileCheckpoint" | "emitFileLine" | "stopFile">;
	/** Optional: the durable checkpoint is re-persisted through the writer when one is bound. */
	readonly writer?: Pick<TerminalManifestWriter, "scheduleCheckpoint">;
	/** Optional: re-bind the stable `mon_` id to its fresh runtime id so kill_bash keeps resolving it. */
	readonly bindMonitorId?: (monitorId: string, runtimeId: string) => void;
	readonly now?: () => number;
}

/** The live tuple `registry.fileCheckpoint` returns; identical in shape to the persisted checkpoint. */
type LiveCheckpoint = NonNullable<ReturnType<MonitorRegistry["fileCheckpoint"]>>;

/**
 * The single comparison, run once per restore. `created` and `replaced` outrank `modified`:
 * an absent→present transition or a new dev/ino is a stronger statement about the same file.
 */
export function classifyDetachedChange(saved: TerminalManifestCheckpoint, live: LiveCheckpoint): DetachedChange {
	if (!saved.present) return live.present ? "created" : null;
	if (!live.present) return "gone";
	if (live.dev !== saved.dev || live.ino !== saved.ino) return "replaced";
	if (live.mtimeMs !== saved.mtimeMs || live.size !== saved.size || live.digest !== saved.digest) return "modified";
	return null;
}

function lost(reason: string): RestoreHandlerResult {
	return { outcome: "lost", reason };
}

/** Remaining lifetime of a durable watch; a watch with no recorded expiry keeps its default window. */
function remainingMs(monitor: ManifestMonitor, now: number): number {
	if (monitor.expiresAt === null) return DEFAULT_RESTORED_WATCH_MS;
	return Math.max(1, monitor.expiresAt - now);
}

const DEFAULT_RESTORED_WATCH_MS = 300_000;

/**
 * Build the `checkpointed-file` restore handler. It re-registers the watch under its original
 * `mon_` id and approved parent (so the permission decision still holds), then reports at most
 * one detached-change line. Returns `lost` when the path is gone or unreadable, `restored` otherwise.
 */
export function createCheckpointedFileRestoreHandler(deps: CheckpointedFileRestoreDeps): RestoreHandler {
	const now = deps.now ?? Date.now;
	return async (monitor: ManifestMonitor): Promise<RestoreHandlerResult> => {
		if (monitor.runtimeKind !== "file" || monitor.path === undefined || monitor.cwd === undefined) {
			return lost(`monitor ${monitor.monitorId} is not a restorable file watch`);
		}
		const saved = monitor.lastCheckpoint;
		if (saved === null) return lost(`monitor ${monitor.monitorId} has no checkpoint to compare against`);
		// A watch whose file existed at checkpoint time but is gone or unreadable now cannot be
		// resumed; probe BEFORE re-registering so a lost restore never leaves a live watch behind.
		if (saved.present) {
			try {
				const target = await stat(resolve(monitor.cwd, monitor.path));
				if (!target.isFile()) return lost(`watched path is no longer a regular file: ${monitor.path}`);
			} catch (error) {
				return lost(`watched path is gone: ${monitor.path} (${error instanceof Error ? error.message : error})`);
			}
		}

		let runtimeId: string;
		try {
			const registered = await deps.registry.registerFile({
				description: monitor.description,
				path: monitor.path,
				monitorId: monitor.monitorId,
				event: monitor.event ?? "create",
				timeoutMs: remainingMs(monitor, now()),
				cwd: monitor.cwd,
				// Preserve the parent approved at permission time: registerFile re-checks it.
				...(monitor.approvedParent !== undefined ? { approvedParent: monitor.approvedParent } : {}),
				// The persisted deadline rides through verbatim; a restore never extends it.
				...(monitor.expiresAt !== null ? { expiresAt: monitor.expiresAt } : {}),
			});
			runtimeId = registered.id;
		} catch (error) {
			return lost(`cannot re-watch ${monitor.path}: ${error instanceof Error ? error.message : String(error)}`);
		}

		const live = deps.registry.fileCheckpoint(runtimeId);
		if (live === undefined) return lost(`monitor ${monitor.monitorId} settled before its checkpoint was compared`);

		const change = classifyDetachedChange(saved, live);
		if (change === "gone") {
			// Lost the race with a deletion between the probe and re-registration: report lost, not a
			// change, and settle the watch just registered so a lost restore leaves nothing behind.
			await deps.registry.stopFile(runtimeId);
			return lost(`watched path is gone: ${monitor.path}`);
		}

		deps.bindMonitorId?.(monitor.monitorId, runtimeId);
		if (change !== null) deps.registry.emitFileLine(runtimeId, `changed while detached: ${change} ${monitor.path}`);
		// Re-checkpoint on every restore: after `replaced` this is the new identity, and otherwise
		// it re-states the tuple the next restart compares against.
		deps.writer?.scheduleCheckpoint(monitor.monitorId, live);
		return { outcome: "restored" };
	};
}
