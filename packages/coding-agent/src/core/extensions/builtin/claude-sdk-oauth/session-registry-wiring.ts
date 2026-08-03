import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "../../types.ts";
import { CLAUDE_SDK_OAUTH_PROVIDER_ID } from "./account-management.ts";
import { AssistantCommitBoundary, isResidentAssistant, isTerminalFailure } from "./session-commit-boundary.ts";
import { bindingFromEntry, rememberBinding } from "./session-reattach.ts";
import {
	closeSession,
	getSession,
	recordBranchInfo,
	recordPendingFork,
	switchSessionModel,
} from "./session-registry.ts";

const commitBoundary = new AssistantCommitBoundary();

function keepBindingThenClose(sessionId: string, reason: string): void {
	const entry = getSession(sessionId);
	if (entry) rememberBinding(bindingFromEntry(entry, []));
	closeSession(sessionId, reason);
}

function residentEntryFor(sessionId: string, message: AssistantMessage) {
	const entry = getSession(sessionId);
	if (!entry || !isResidentAssistant(message, entry.modelId)) return undefined;
	return entry;
}

export function registerSessionRegistry(pi: Pick<ExtensionAPI, "on">): void {
	pi.on("session_compact", (_event, ctx) => {
		recordPendingFork(ctx.sessionManager.getSessionId(), "compaction");
	});
	pi.on("session_before_fork", (_event, ctx) => {
		recordPendingFork(ctx.sessionManager.getSessionId(), "fork");
	});
	pi.on("session_tree", (event, ctx) => {
		if (event.oldLeafId === null || event.newLeafId === null) return;
		recordBranchInfo(ctx.sessionManager.getSessionId(), {
			oldLeafId: event.oldLeafId,
			newLeafId: event.newLeafId,
		});
	});
	pi.on("model_select", async (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (event.model?.provider !== CLAUDE_SDK_OAUTH_PROVIDER_ID) {
			closeSession(sessionId, "model_selected");
			return;
		}
		if (!(await switchSessionModel(sessionId, event.model.id))) {
			keepBindingThenClose(sessionId, "model_selected");
		}
	});
	pi.on("thinking_level_select", (_event, ctx) => {
		keepBindingThenClose(ctx.sessionManager.getSessionId(), "thinking_level_selected");
	});
	pi.on("message_update", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const sessionId = ctx.sessionManager.getSessionId();
		if (residentEntryFor(sessionId, event.message)) {
			commitBoundary.captureProviderFinal(sessionId, event.message);
		}
	});
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const sessionId = ctx.sessionManager.getSessionId();
		const entry = getSession(sessionId);
		if (!entry) return;
		if (isTerminalFailure(event.message)) {
			commitBoundary.forget(sessionId);
			return;
		}
		if (commitBoundary.commit(sessionId, event.message, entry.modelId) === "rewritten") {
			recordPendingFork(sessionId, "assistant_rewritten");
		}
	});
	pi.on("session_shutdown", (event, ctx) => {
		closeSession(ctx.sessionManager.getSessionId(), event.reason);
	});
	pi.on("session_extensions_removed", (_event, ctx) => {
		closeSession(ctx.sessionManager.getSessionId(), "extensions_removed");
	});
}
