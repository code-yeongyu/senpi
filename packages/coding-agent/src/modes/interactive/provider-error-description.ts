import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	describeProviderFailureForUser,
	SERVER_FALLBACK_ABORTED_DIAGNOSTIC,
} from "@earendil-works/pi-ai";
import { usageLimitScope } from "../../core/retry-fallback/usage-limit.ts";

/**
 * The classified, plain-language text the transcript row shows for a failed assistant turn, or
 * undefined when no classifier recognised the failure and the row shows the raw provider error.
 */
export function describedProviderError(message: AssistantMessage): string | undefined {
	return message.errorCause?.type === "usage_limit" && message.errorCause.scope === "account"
		? message.errorMessage
		: describeProviderFailureForUser(message.errorMessage, {
				model: `${message.provider}/${message.model}`,
				usageLimit: usageLimitScope(message),
			});
}

/** A text run follows the last tool call, so the run that ends the message carries the turn's notice. */
function endsInTextRun(message: AssistantMessage): boolean {
	return message.content.some((content) => content.type === "toolCall") && message.content.at(-1)?.type !== "toolCall";
}

/** The live head row leaves the turn-ending notice to the trailing text run when there is one (senpi#4958). */
export function headNoticeShownElsewhere(message: AssistantMessage): boolean {
	return endsInTextRun(message);
}

/**
 * Whether the turn's failed assistant row already shows classified text, so a turn-end failure line
 * would print the same failure a second time (senpi#4950). Only the text run that ends the message
 * shows the error (senpi#4954), so a message that ends in a tool call, or an aborted server fallback,
 * shows no error row and leaves the turn-end line as the only one.
 */
export function failureAlreadyDescribed(messages: readonly AgentMessage[]): boolean {
	const last = messages.findLast((message) => message.role === "assistant");
	if (last?.role !== "assistant" || last.stopReason !== "error") return false;
	if (last.content.at(-1)?.type === "toolCall") return false;
	if (last.diagnostics?.some((entry) => entry.type === SERVER_FALLBACK_ABORTED_DIAGNOSTIC)) return false;
	return describedProviderError(last) !== undefined;
}
