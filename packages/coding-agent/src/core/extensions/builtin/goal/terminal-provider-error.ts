import type { AgentEndEvent } from "../../types.ts";
import { lastAssistantMessage } from "./last-assistant-message.ts";

// The claude-sdk-oauth account-rotating proxy reports total account exhaustion as
// an assistant message with `stopReason: "stop"` and zero usage, so it slips past
// the stopReason checks below and the goal reads it as a clean turn end. Match the
// two stable phrases of that exact response; the account count and the `Retry in
// NNNs` suffix vary, so they are not part of the match.
const SDK_OAUTH_EXHAUSTION_MARKERS = ["API Error: Server is temporarily limiting requests", "accounts exhausted"];

function isSdkOauthAccountExhaustion(
	message: { api?: string; stopReason?: string; content?: unknown } | undefined,
): boolean {
	if (message?.api !== "claude-sdk-oauth" || message.stopReason !== "stop") return false;
	const text = Array.isArray(message.content)
		? message.content.map((part) => (part?.type === "text" ? part.text : "")).join("\n")
		: "";
	return SDK_OAUTH_EXHAUSTION_MARKERS.every((marker) => text.includes(marker));
}

export function didTerminalProviderErrorEndTurn(event: AgentEndEvent): boolean {
	if (event.abortSource === "system") return false;
	if (event.willRetry !== false) return false;
	const message = lastAssistantMessage(event.messages);
	if (isSdkOauthAccountExhaustion(message)) return true;
	return message?.stopReason === "error" || (message?.stopReason === "aborted" && event.abortSource !== "user");
}
