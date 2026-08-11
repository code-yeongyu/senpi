import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CLAUDE_SDK_OAUTH_PROVIDER_ID } from "./account-management.ts";
import { sessionSyncDigest } from "./session-sync.ts";

export type AssistantCommitOutcome = "clean" | "rewritten" | "not-resident";

export function assistantContentHash(message: AssistantMessage): string {
	return sessionSyncDigest({
		role: message.role,
		api: message.api,
		provider: message.provider,
		model: message.model,
		content: message.content.map((block) => {
			if (block.type !== "thinking") return block;
			// Agent-core stamps these display-only fields after the final
			// message_update; every semantic thinking field stays fail-closed.
			const stableBlock = { ...block };
			delete stableBlock.startedAt;
			delete stableBlock.endedAt;
			return stableBlock;
		}),
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
