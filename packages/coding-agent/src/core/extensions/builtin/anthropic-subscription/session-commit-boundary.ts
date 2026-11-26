import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ANTHROPIC_SUBSCRIPTION_PROVIDER_ID } from "./account-management.ts";
import { CLAUDE_SDK_OAUTH_API_ID } from "./api-id.ts";
import {
	type AssistantSemanticProjection,
	firstDivergedPath,
	snapshotProjection,
} from "./session-commit-divergence.ts";
import { sessionSyncDigest } from "./session-sync.ts";

export type AssistantCommitOutcome = "clean" | "rewritten" | "not-resident";

export type AssistantCommitResult = {
	outcome: AssistantCommitOutcome;
	/** senpi#1975: first diverged field path on a rewrite. Paths only, never values. */
	divergedPath?: string;
};

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

function semanticProjection(message: AssistantMessage): AssistantSemanticProjection {
	return {
		role: message.role,
		api: message.api,
		provider: message.provider,
		model: message.model,
		content: message.content.map(semanticContentBlock),
	};
}

export function assistantContentHash(message: AssistantMessage): string {
	return sessionSyncDigest(semanticProjection(message));
}

export function isResidentAssistant(message: AssistantMessage, modelId: string): boolean {
	return (
		message.api === CLAUDE_SDK_OAUTH_API_ID &&
		message.provider === ANTHROPIC_SUBSCRIPTION_PROVIDER_ID &&
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
	private readonly providerFinalByKey = new Map<string, { hash: string; projection: AssistantSemanticProjection }>();

	captureProviderFinal(key: string, message: AssistantMessage): void {
		const projection = semanticProjection(message);
		this.providerFinalByKey.set(key, {
			hash: sessionSyncDigest(projection),
			projection: snapshotProjection(projection),
		});
	}

	commit(key: string, message: AssistantMessage, modelId: string): AssistantCommitResult {
		const providerFinal = this.providerFinalByKey.get(key);
		this.providerFinalByKey.delete(key);
		if (!isResidentAssistant(message, modelId)) return { outcome: "not-resident" };
		if (providerFinal === undefined) return { outcome: "clean" };
		const committed = semanticProjection(message);
		if (providerFinal.hash === sessionSyncDigest(committed)) return { outcome: "clean" };
		return { outcome: "rewritten", divergedPath: firstDivergedPath(providerFinal.projection, committed) };
	}

	forget(key: string): void {
		this.providerFinalByKey.delete(key);
	}
}
