/**
 * The `checkpointed-rpc` durability class: a persistent rpc watch comes back under its original `mon_`
 * id, re-resolves its target, re-subscribes, and reports once, through the same sink, what changed while
 * nothing watched: a session whose status moved, one that is gone, a host whose generation changed.
 * `seq` is never compared across hosts or generations; only statuses and generations are.
 */
import { getAgentDir } from "../../../../config.ts";
import type { MonitorRegistry } from "./monitor-registry.ts";
import {
	type PersistedMuteRegistry,
	type RestoreContext,
	type RestoreHandler,
	type RestoreHandlerResult,
	reapplyPersistedMute,
} from "./restore.ts";
import { defaultEvents, parseRpcTarget } from "./rpc-monitor-targets.ts";
import type { TerminalManifestWriter } from "./terminal-manifest.ts";
import type { ManifestMonitor } from "./terminal-manifest-model.ts";

export interface CheckpointedRpcRestoreDeps {
	readonly registry: Pick<MonitorRegistry, "registerRpc"> & PersistedMuteRegistry;
	readonly writer?: Pick<TerminalManifestWriter, "scheduleRpcCheckpoint">;
	readonly bindMonitorId?: (monitorId: string, runtimeId: string) => void;
	/** This session's durable id, which a `children` target names. */
	readonly sessionId: () => string | undefined;
	readonly agentDir?: string;
}

function lost(reason: string): RestoreHandlerResult {
	return { outcome: "lost", reason };
}

export function createCheckpointedRpcRestoreHandler(deps: CheckpointedRpcRestoreDeps): RestoreHandler {
	return async (monitor: ManifestMonitor, context: RestoreContext): Promise<RestoreHandlerResult> => {
		if (monitor.runtimeKind !== "rpc" || monitor.target === undefined)
			return lost(`monitor ${monitor.monitorId} is not a restorable rpc watch`);
		const target = parseRpcTarget(monitor.target, deps.sessionId());
		if ("error" in target) return lost(target.error);
		let filter: RegExp | undefined;
		try {
			filter = monitor.filter === undefined ? undefined : new RegExp(monitor.filter);
		} catch {
			return lost(`monitor ${monitor.monitorId} has an invalid filter`);
		}
		try {
			const { id } = await deps.registry.registerRpc({
				description: monitor.description,
				target,
				targetText: monitor.target,
				events: monitor.events ?? defaultEvents(target),
				exclude: monitor.exclude ?? [],
				...(filter === undefined ? {} : { filter }),
				persistent: monitor.persistent,
				...(context.remainingMs === undefined ? {} : { timeoutMs: context.remainingMs }),
				...(monitor.expiresAt === null ? {} : { expiresAt: monitor.expiresAt }),
				monitorId: monitor.monitorId,
				agentDir: deps.agentDir ?? getAgentDir(),
				...(monitor.rpcCheckpoint === undefined ? {} : { restoredFrom: monitor.rpcCheckpoint }),
				onCheckpoint: (monitorId, checkpoint) => deps.writer?.scheduleRpcCheckpoint(monitorId, checkpoint),
			});
			deps.bindMonitorId?.(monitor.monitorId, id);
			// A watch muted before the restart stays muted, as a file watch does.
			return { outcome: reapplyPersistedMute(deps.registry, monitor, id) };
		} catch (error) {
			return lost(`cannot re-watch ${monitor.target}: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
}
