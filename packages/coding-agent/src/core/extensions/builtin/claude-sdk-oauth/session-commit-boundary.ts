import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CLAUDE_SDK_OAUTH_PROVIDER_ID } from "./account-management.ts";
import { sessionSyncDigest } from "./session-sync.ts";

export type AssistantCommitOutcome = "clean" | "rewritten" | "not-resident";

type ContentBlock = AssistantMessage["content"][number];

/**
 * Only the payload the model produced is fingerprinted. Everything the stream
 * pipeline stamps around it (thinking timing, content-block indices, partial
 * JSON) can legitimately differ between the last `message_update` and `message_end`
 * without any extension rewriting the answer; hashing such fields marked plain
 * turns `assistant_rewritten` and forced a full re-send on the next turn
 * (senpi#691, oh-my-openagent#7925). An unknown block shape stays fail-closed.
 */
function semanticContentBlock(block: ContentBlock): unknown {
	switch (block.type) {
		case "text":
			return { type: block.type, text: block.text };
		case "thinking":
			return { type: block.type, thinking: block.thinking, thinkingSignature: block.thinkingSignature };
		case "toolCall":
			return { type: block.type, id: block.id, name: block.name, arguments: block.arguments };
		default:
			return block;
	}
}

export function assistantContentHash(message: AssistantMessage): string {
	return sessionSyncDigest({
		role: message.role,
		api: message.api,
		provider: message.provider,
		model: message.model,
		content: message.content.map(semanticContentBlock),
	});
}

export function isResidentAssistant(message: AssistantMessage, modelId: string): boolean {
	return (
		message.api === CLAUDE_SDK_OAUTH_PROVIDER_ID &&
		message.provider === CLAUDE_SDK_OAUTH_PROVIDER_ID &&
		message.model === modelId
	);
}

export function isTerminalFailure(message: AssistantMessage): boolean {
	return message.stopReason === "error" || message.stopReason === "aborted";
}

/**
 * Divergence is decided by comparing what the provider streamed against what the
 * session ledger committed, never by in-flight staging: a result-only turn fills
 * its content at the terminal message with no preceding delta, so a staged-hash
 * comparison reports false divergence on a perfectly valid SDK response shape.
 */
export class AssistantCommitBoundary {
	private readonly providerFinalByKey = new Map<string, string>();

	captureProviderFinal(key: string, message: AssistantMessage): void {
		this.providerFinalByKey.set(key, assistantContentHash(message));
	}

	commit(key: string, message: AssistantMessage, modelId: string): AssistantCommitOutcome {
		const providerFinal = this.providerFinalByKey.get(key);
		this.providerFinalByKey.delete(key);
		if (!isResidentAssistant(message, modelId)) return "not-resident";
		if (providerFinal === undefined) return "clean";
		return providerFinal === assistantContentHash(message) ? "clean" : "rewritten";
	}

	forget(key: string): void {
		this.providerFinalByKey.delete(key);
	}
}
