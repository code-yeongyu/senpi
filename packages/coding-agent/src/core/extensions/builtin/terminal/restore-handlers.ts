/**
 * The restore handlers a session's terminal persistence runs, one per durability class: each adopts the
 * restored watch into the session's manifest and re-binds its stable `mon_` id to the fresh runtime id.
 */
import { createRestartableCommandHandler } from "./durable-command.ts";
import { createCheckpointedFileRestoreHandler } from "./durable-file.ts";
import { createCheckpointedRpcRestoreHandler } from "./durable-rpc.ts";
import { type RestoreHandler, type RestoreHandlers, reapplyPersistedMute } from "./restore.ts";
import type { TerminalSessionBundle } from "./session-bundle.ts";
import type { TerminalManifestWriter } from "./terminal-manifest.ts";
import type { TerminalToolContext } from "./tools/context.ts";

export function restoreHandlers(
	writer: TerminalManifestWriter,
	toolCtx: TerminalToolContext,
	bundle: TerminalSessionBundle,
	graceMs: number | undefined,
): RestoreHandlers {
	const registry = bundle.monitors;
	const adopting =
		(handler: RestoreHandler): RestoreHandler =>
		async (monitor, context) => {
			const result = await handler(monitor, context);
			// Only a LIVE entry is re-adopted, so the next persist keeps it and drops the rest.
			if (result.outcome === "restored" || result.outcome === "muted") {
				writer.adoptRestored(result.runtime === undefined ? monitor : { ...monitor, runtime: result.runtime });
				registry.adoptFireWindow(monitor.monitorId, monitor.fireWindow);
			}
			return result;
		};
	let freshFileRuntimeId: string | undefined;
	const checkpointedFile = createCheckpointedFileRestoreHandler({
		registry,
		writer,
		bindMonitorId: (monitorId, runtimeId) => {
			freshFileRuntimeId = runtimeId;
			bundle.manager.bindMonitorId(monitorId, runtimeId);
		},
	});
	return {
		"restartable-command": adopting(
			createRestartableCommandHandler({
				ctx: toolCtx,
				registry,
				...(graceMs !== undefined ? { graceMs } : {}),
			}),
		),
		"checkpointed-file": adopting(async (monitor, context) => {
			freshFileRuntimeId = undefined;
			const result = await checkpointedFile(monitor, context);
			if (result.outcome !== "restored" || freshFileRuntimeId === undefined) return result;
			return { ...result, outcome: reapplyPersistedMute(registry, monitor, freshFileRuntimeId) };
		}),
		"checkpointed-rpc": adopting(
			createCheckpointedRpcRestoreHandler({
				registry,
				writer,
				bindMonitorId: (monitorId, runtimeId) => bundle.manager.bindMonitorId(monitorId, runtimeId),
				sessionId: () => toolCtx.getSessionContext?.()?.sessionManager?.getSessionId?.(),
			}),
		),
	};
}
