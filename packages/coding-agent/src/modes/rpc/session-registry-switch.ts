/**
 * The replacement a multi-session entry routes `switchSession` through: serialized on the entry's
 * lifecycle mutex, and - when the replacement moved cwd - re-wrapped so every attached client keeps
 * resolving against the entry's CURRENT runtime rather than the one built at `open_session`.
 */
import { AgentSessionRuntime, holdRuntimeSession } from "../../core/agent-session-runtime.ts";
import { ClientAdmissions } from "./client-admissions.ts";
import { EffectLedger } from "./effect-ledger.ts";
import type { PreparableRuntimeFactory } from "./host-warm.ts";
import { type RpcSessionEntry, RpcSessionRegistryError, type SessionRuntime } from "./session-registry-types.ts";

export function createEntrySwitchSession(
	entry: RpcSessionEntry,
	createRuntime: PreparableRuntimeFactory,
	syncRuntimeMetadata: () => void,
): SessionRuntime["switchSession"] {
	return (sessionPath, options) => {
		const operation = entry.lifecycleMutex.then(async () => {
			if (entry.state !== "open" || !entry.runtime) {
				throw new RpcSessionRegistryError("unknown_session");
			}
			const runtime = entry.runtime;
			const cwdOverride = options?.cwdOverride;
			const cwdChanged = cwdOverride !== undefined && runtime.session.sessionManager.getCwd() !== cwdOverride;
			const result = await runtime.switchSession(sessionPath, options);
			if (result.cancelled || !cwdChanged) return result;

			// A multi-session binding outlives an individual replacement. Keep the
			// entry's runtime object aligned with the replacement so every attached
			// client resolves getters and future commands against the new cwd-bound
			// runtime, not the object created during open_session.
			// The replacement's hold is taken BEFORE the old runtime's is released: both name the same session file, so
			// the shared holder record never disappears between the two.
			const hold = await holdRuntimeSession(runtime.session.sessionManager, runtime.launchProfile?.holderEndpoint);
			let replacement: AgentSessionRuntime;
			try {
				replacement = new AgentSessionRuntime(
					runtime.session,
					runtime.services,
					createRuntime,
					[...runtime.diagnostics],
					runtime.modelFallbackMessage,
					runtime.launchProfile,
					hold,
				);
				replacement.setRebindSession(entry.rebindSession);
				ClientAdmissions.sealQueuedOnReplace(replacement);
				EffectLedger.sealOnReplace(replacement);
			} catch (error) {
				hold?.release();
				throw error;
			}
			runtime.releaseSessionHold();
			entry.runtime = replacement;
			syncRuntimeMetadata();
			return result;
		});
		entry.lifecycleMutex = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	};
}
