/**
 * The wire projection of one session's state - `get_state`, `open_session`, a worker's snapshot and
 * the TUI control endpoint all answer through this one function, so no surface can drift from another.
 */
import { existsSync } from "node:fs";
import { sanitizeProviderDiagnostic } from "@earendil-works/pi-ai";
import type { AgentAbortSource } from "../../core/agent-abort-provenance.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { ProjectTrustStore } from "../../core/trust-manager.ts";
import { clientFacingIdentity } from "./client-admission-record.ts";
import { sessionQuestionBridges } from "./connection-question-bridge.ts";
import { observeLifecycle } from "./lifecycle-delivery.ts";
import type { RpcSessionState } from "./rpc-types.ts";
import { sessionUiAnswerLedger } from "./ui-answer-ledger.ts";
import { sessionDialogRequests } from "./session-extension-ui-requests.ts";

/**
 * Project one session into the wire state shape.
 *
 * Shared with `open_session` (session-command-router) so both surfaces answer with the SAME
 * fields: a second hand-rolled literal silently drifts, which is how `serviceTier`/`fastMode`
 * would otherwise be missing from an opened session's initial state.
 *
 * `lastAbortSource` is passed in rather than read from the session: `session.currentAbortSource`
 * is cleared once the turn settles, so only the caller that observed `agent_end` still knows
 * who owned the abort.
 */
export function buildRpcSessionState(session: AgentSession, lastAbortSource?: AgentAbortSource): RpcSessionState {
	const cwd = session.sessionManager.getCwd();
	// Trust gates project-source settings (shell prefixes, project resources), so every
	// session state projection must have an authoritative store to consult.
	if (!session.agentDir) {
		throw new Error("RPC session invariant violated: agentDir is required");
	}
	const projectTrusted = new ProjectTrustStore(session.agentDir).get(cwd) === true;
	const lastProviderDiagnostic = sanitizeProviderDiagnostic(session.agent.state.providerDiagnostic);
	return {
		answeredUiRequests: sessionUiAnswerLedger(session).snapshot(),
		paused: session.paused ?? false,
		pausedNoticeCount: session.pausedNoticeCount ?? 0,
		holds: session.holds ?? [],
		lifecycle: observeLifecycle(session.lifecycle),
		pendingQuestions: sessionQuestionBridges.get(session)?.pendingQuestions(),
		pendingDialogs: sessionDialogRequests.get(session)?.snapshot() ?? [],
		model: session.model,
		pendingModelSwitch: session.pendingModelSwitch
			? {
					provider: session.pendingModelSwitch.model.provider,
					id: session.pendingModelSwitch.model.id,
				}
			: null,
		thinkingLevel: session.thinkingLevel,
		...(session.thinkingSelection ? { thinkingSelection: session.thinkingSelection } : {}),
		...(session.thinkingLevelSource === undefined ? {} : { thinkingLevelSource: session.thinkingLevelSource }),
		...(typeof session.getSessionModelThinkingLevels === "function"
			? { sessionModelThinkingLevels: session.getSessionModelThinkingLevels() }
			: {}),
		...(lastAbortSource ? { lastAbortSource } : {}),
		...(lastProviderDiagnostic ? { lastProviderDiagnostic } : {}),
		serviceTier: session.effectiveServiceTier,
		fastMode: session.isFastModeActive(),
		isStreaming: session.isStreaming,
		pausedHeldInputCount: session.pausedHeldInputCount,
		runPaused: session.runPaused,
		pause: session.pauseView,
		isCompacting: session.isCompacting,
		retryAttempt: session.retryAttempt,
		isBashRunning: session.isBashRunning,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		sessionFile: session.sessionFile,
		sessionId: session.sessionId,
		sessionName: session.sessionName,
		cwd,
		projectTrusted,
		...(session.sessionFile &&
		!existsSync(session.sessionFile) &&
		session.sessionManager
			.getEntries()
			.some(
				(entry) =>
					entry.type !== "model_change" &&
					entry.type !== "model_change_rejected" &&
					entry.type !== "thinking_level_change",
			)
			? { entries: session.sessionManager.getEntries() }
			: {}),
		steering: typeof session.getSteeringMessages === "function" ? [...session.getSteeringMessages()] : [],
		followUp: typeof session.getFollowUpMessages === "function" ? [...session.getFollowUpMessages()] : [],
		ordered: typeof session.getQueuedInputs === "function" ? session.getQueuedInputs().map(clientFacingIdentity) : [],
		autoCompactionEnabled: session.autoCompactionEnabled,
		messageCount: session.messages.length,
		pendingMessageCount: session.pendingMessageCount,
		usageTotals: session.sessionManager.getUsageTotals(),
		contextUsage: typeof session.getContextUsage === "function" ? session.getContextUsage() : undefined,
		favoriteModels: session.favoriteModels?.map((entry) => ({ ...entry })) ?? [],
		scopedModels: session.scopedModels?.map((entry) => ({ ...entry })) ?? [],
	};
}
