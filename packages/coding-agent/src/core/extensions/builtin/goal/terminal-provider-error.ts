import { isClassifierRefusal } from "@earendil-works/pi-ai";
import type { AgentEndEvent } from "../../types.ts";
import { lastAssistantMessage } from "./last-assistant-message.ts";

// The anthropic-subscription account-rotating proxy reports total account exhaustion as
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

// Codex backend type:error responses persist only the message, not the policy
// code/payload. Match that diagnostic, never ordinary assistant text.
const CODEX_POLICY_ERROR_PATTERN =
	/^(?:Codex error: )?This request was blocked by our safety systems\.(?: Reason: .+)?$/i;
const CODEX_RESPONSES_API = "openai-codex-responses";

/**
 * The sentence above is a provider-agnostic string with no policy code, so it is
 * only trustworthy as a terminal policy signal on the API that produces it.
 * Another provider or gateway emitting the same text keeps the existing
 * provider/system recovery path instead of being stranded as blocked.
 */
function isCodexPolicyRejection(message: { api?: string; stopReason?: string; errorMessage?: string }): boolean {
	if (message.api !== CODEX_RESPONSES_API) return false;
	if (message.stopReason !== "error") return false;
	return CODEX_POLICY_ERROR_PATTERN.test(message.errorMessage ?? "");
}

export function didTerminalPolicyRejectionEndTurn(event: AgentEndEvent): boolean {
	if (event.willRetry !== false) return false;
	const message = lastAssistantMessage(event.messages);
	if (message === undefined) return false;
	// Structured refusals carry their own provider-independent policy details;
	// only the unstructured Codex diagnostic needs the identity check.
	return isClassifierRefusal(message) || isCodexPolicyRejection(message);
}

export interface TerminalProviderAuthFailure {
	readonly httpStatus: 401 | 403;
	readonly provider: string;
	readonly model: string;
}

const LEADING_AUTH_STATUS_PATTERN = /^(401|403)\b/;

function authStatusOf(message: {
	errorMessage?: string;
	providerDiagnostic?: { category: string; httpStatus?: number };
}): 401 | 403 | undefined {
	const diagnostic = message.providerDiagnostic;
	// The adapter's structured reading of the transport error outranks the text;
	// the leading status is only consulted for adapters that mint no diagnostic.
	if (diagnostic !== undefined) {
		if (diagnostic.httpStatus === 401 || diagnostic.httpStatus === 403) return diagnostic.httpStatus;
		return diagnostic.category === "auth" ? 401 : undefined;
	}
	const status = LEADING_AUTH_STATUS_PATTERN.exec(message.errorMessage ?? "")?.[1];
	return status === "401" ? 401 : status === "403" ? 403 : undefined;
}

/**
 * A 401/403 that still ends the turn after every retry owner declined (#2293).
 * The credential pool already failed over or refreshed what it could, so the
 * same request is rejected again on every continuation.
 */
export function terminalProviderAuthFailure(event: AgentEndEvent): TerminalProviderAuthFailure | undefined {
	if (event.abortSource === "system") return undefined;
	if (event.willRetry !== false) return undefined;
	const message = lastAssistantMessage(event.messages);
	if (message?.stopReason !== "error") return undefined;
	const httpStatus = authStatusOf(message);
	if (httpStatus === undefined) return undefined;
	return { httpStatus, provider: message.provider, model: message.model };
}

export function didTerminalProviderErrorEndTurn(event: AgentEndEvent): boolean {
	if (event.abortSource === "system") return false;
	if (event.willRetry !== false) return false;
	const message = lastAssistantMessage(event.messages);
	if (isSdkOauthAccountExhaustion(message)) return true;
	return message?.stopReason === "error" || (message?.stopReason === "aborted" && event.abortSource !== "user");
}
