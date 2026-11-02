import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, isContextOverflow } from "@earendil-works/pi-ai/compat";
import { isBillingErrorMessage } from "./billing.ts";

export const REQUEST_SHAPE_RECOVERY_ENTRY_TYPE = "request-shape-recovery";

export const REQUEST_SHAPE_RECOVERY_NOTE = "Retried without web search replay data";

export const REQUEST_SHAPE_FAILURE_TEXT =
	"Anthropic rejected this conversation's request format, even after retrying without web search replay data. " +
	"Run /compact or start a new session to continue, and report it if it happens again.";

const INVALID_REQUEST_PATTERN = /\binvalid_request_error\b/;

/** Gateways speak the same wire but answer their own 400s; only Anthropic's own rejection is a replay-shape problem. */
const ANTHROPIC_PROVIDER = "anthropic";

/** A request-shape 400 is ours to fix, not the model's: it never walks the fallback chain (senpi#3727). */
export function isAnthropicRequestShapeRejection(message: AssistantMessage, contextWindow: number): boolean {
	return (
		message.stopReason === "error" &&
		message.api === "anthropic-messages" &&
		message.provider === ANTHROPIC_PROVIDER &&
		INVALID_REQUEST_PATTERN.test(message.errorMessage ?? "") &&
		!isBillingErrorMessage(message.errorMessage) &&
		!isContextOverflow(message, contextWindow)
	);
}

export interface ProviderNativeStripResult {
	readonly messages: AgentMessage[];
	readonly strippedBlocks: number;
}

/** Only assistant `providerNative` blocks at or before `cutoff` go; user text and client tool pairs never do. */
export function stripProviderNativeReplay(
	messages: readonly AgentMessage[],
	cutoff: number,
): ProviderNativeStripResult {
	let strippedBlocks = 0;
	const stripped = messages.map((message) => {
		if (message.role !== "assistant" || message.timestamp > cutoff) return message;
		const content = message.content.filter((block) => block.type !== "providerNative");
		if (content.length === message.content.length) return message;
		strippedBlocks += message.content.length - content.length;
		return { ...message, content };
	});
	return { messages: stripped, strippedBlocks };
}

export type RequestShapeDecision = "recover" | "give-up" | "not-request-shape";

/** One same-model recovery per failing streak; older history stays stripped because the bad block is still in it. */
export class RequestShapeRecovery {
	private cutoff: number | undefined;
	private attempted = false;

	decide(message: AssistantMessage, contextWindow: number): RequestShapeDecision {
		if (!isAnthropicRequestShapeRejection(message, contextWindow)) return "not-request-shape";
		return this.attempted ? "give-up" : "recover";
	}

	begin(failedAt: number): void {
		this.attempted = true;
		this.cutoff = failedAt;
	}

	/** Any non-request-shape outcome (success, another error, a new prompt) ends the streak. */
	endStreak(): void {
		this.attempted = false;
	}

	apply(messages: AgentMessage[]): AgentMessage[] {
		if (this.cutoff === undefined) return messages;
		return stripProviderNativeReplay(messages, this.cutoff).messages;
	}
}
