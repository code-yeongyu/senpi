import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { CLAUDE_SDK_OAUTH_PROVIDER_ID } from "./account-management.ts";
import {
	BINDING_ENTRY_TYPE,
	BINDING_MARKER,
	type BindingInvalidation,
	bindingFromStoredBranch,
	storedBindingFromBinding,
	storedBindingFromEntry,
} from "./session-binding.ts";
import { deleteStoredBinding, readStoredBinding, writeStoredBinding } from "./session-binding-store.ts";
import {
	AssistantCommitBoundary,
	assistantContentHash,
	isResidentAssistant,
	isTerminalFailure,
} from "./session-commit-boundary.ts";
import { bindingFromEntry, forgetBinding, getBinding, rememberBinding } from "./session-reattach.ts";
import {
	closeSession,
	getSession,
	recordBranchInfo,
	recordPendingFork,
	switchSessionModel,
} from "./session-registry.ts";
import { isTransmittedMessage, sentHashesForEntry, sentMessageHashes } from "./session-sync.ts";

const commitBoundary = new AssistantCommitBoundary();

function persistBindingInvalidation(pi: Partial<Pick<ExtensionAPI, "appendEntry">>, reason: string): void {
	pi.appendEntry?.(BINDING_ENTRY_TYPE, { schemaVersion: 1, invalidated: true, reason } satisfies BindingInvalidation);
}

async function invalidateBinding(
	pi: Partial<Pick<ExtensionAPI, "appendEntry">>,
	ctx: Pick<ExtensionContext, "sessionManager">,
	reason: string,
): Promise<void> {
	const sessionId = ctx.sessionManager.getSessionId();
	forgetBinding(sessionId);
	const sessionFile = ctx.sessionManager.getSessionFile?.();
	if (sessionFile) await deleteStoredBinding(sessionFile);
	persistBindingInvalidation(pi, reason);
}

function keepBindingThenClose(sessionId: string, reason: string): void {
	const entry = getSession(sessionId);
	if (entry) rememberBinding(bindingFromEntry(entry, sentHashesForEntry(entry) ?? []));
	closeSession(sessionId, reason);
}

function residentEntryFor(sessionId: string, message: AssistantMessage) {
	const entry = getSession(sessionId);
	if (!entry || !isResidentAssistant(message, entry.modelId)) return undefined;
	return entry;
}

export function registerSessionRegistry(
	pi: Pick<ExtensionAPI, "on"> & Partial<Pick<ExtensionAPI, "appendEntry">>,
): void {
	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "reload") return;
		const sessionId = ctx.sessionManager.getSessionId();
		forgetBinding(sessionId);
		const sessionFile = ctx.sessionManager.getSessionFile?.();
		if (event.reason === "new") return;
		if (event.reason === "fork") {
			if (sessionFile) await deleteStoredBinding(sessionFile);
			persistBindingInvalidation(pi, "fork");
			return;
		}
		if (!sessionFile) return;
		const stored = await readStoredBinding(sessionFile);
		if (!stored) return;
		if (stored.sessionId !== sessionId) {
			await deleteStoredBinding(sessionFile);
			return;
		}
		const binding = bindingFromStoredBranch(ctx.sessionManager.getBranch(), stored);
		if (!binding) {
			await deleteStoredBinding(sessionFile);
			return;
		}
		rememberBinding(binding);
	});
	pi.on("session_compact", async (event, ctx) => {
		if (!event.accepted) return;
		recordPendingFork(ctx.sessionManager.getSessionId(), "compaction");
		await invalidateBinding(pi, ctx, "compaction");
	});
	pi.on("session_tree", async (event, ctx) => {
		if (event.oldLeafId === null || event.newLeafId === null) return;
		recordBranchInfo(ctx.sessionManager.getSessionId(), {
			oldLeafId: event.oldLeafId,
			newLeafId: event.newLeafId,
		});
		await invalidateBinding(pi, ctx, "tree_changed");
	});
	pi.on("model_select", async (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (event.model?.provider !== CLAUDE_SDK_OAUTH_PROVIDER_ID) {
			closeSession(sessionId, "model_selected");
			await invalidateBinding(pi, ctx, "model_selected");
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
	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const sessionId = ctx.sessionManager.getSessionId();
		const entry = getSession(sessionId);
		const binding = getBinding(sessionId);
		const modelId = entry?.modelId ?? binding?.modelId;
		if (!modelId) return;
		if (isTerminalFailure(event.message)) {
			commitBoundary.forget(sessionId);
			return;
		}
		const outcome = commitBoundary.commit(sessionId, event.message, modelId);
		if (outcome === "rewritten") {
			recordPendingFork(sessionId, "assistant_rewritten");
			await invalidateBinding(pi, ctx, "assistant_rewritten");
			return;
		}
		// Only an assistant this provider actually produced may anchor a record.
		if (outcome !== "clean") return;
		const sessionFile = ctx.sessionManager.getSessionFile?.();
		if (!sessionFile || !pi.appendEntry) return;
		const hashes = sentMessageHashes(ctx.sessionManager.buildSessionContext().messages.filter(isTransmittedMessage));
		if (hashes.length === 0) return;
		pi.appendEntry(BINDING_ENTRY_TYPE, BINDING_MARKER);
		const markerEntryId = ctx.sessionManager.getLeafId();
		if (!markerEntryId) return;
		const anchor = {
			sessionPath: sessionFile,
			sessionId,
			markerEntryId,
			assistantContentHash: assistantContentHash(event.message),
		};
		const stored = entry
			? storedBindingFromEntry(entry, hashes, anchor)
			: binding
				? storedBindingFromBinding(binding, hashes, anchor)
				: undefined;
		if (!stored) return;
		await writeStoredBinding(sessionFile, stored);
	});
	pi.on("session_shutdown", (event, ctx) => {
		closeSession(ctx.sessionManager.getSessionId(), event.reason);
	});
	pi.on("session_extensions_removed", async (_event, ctx) => {
		closeSession(ctx.sessionManager.getSessionId(), "extensions_removed");
		await invalidateBinding(pi, ctx, "extensions_removed");
	});
}
