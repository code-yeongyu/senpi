import type { Message, Model, OpenAIResponsesCompat, PromptCacheDiagnostics } from "../types.ts";

/**
 * GPT-5.6+ OpenAI Responses prompt-cache helpers (senpi#2096). SDK-free so the
 * prewarm eligibility check can run before the OpenAI module is lazily loaded.
 */

export interface OpenAIPromptCacheOptionsPayload {
	mode?: "explicit" | "implicit";
	ttl?: "30m";
	prewarm?: boolean;
	comparison_response_id?: string;
}

/** Explicit prompt-cache models (GPT-5.6+) on the first-party api.openai.com endpoint. */
export function isOpenAIResponsesPromptCacheModel(model: Model<any>): boolean {
	if (model.api !== "openai-responses") return false;
	const compat = model.compat as OpenAIResponsesCompat | undefined;
	if (compat?.supportsExplicitPromptCacheMode !== true) return false;
	try {
		return new URL(model.baseUrl || "https://api.openai.com/v1").hostname === "api.openai.com";
	} catch {
		return false;
	}
}

/**
 * Response id of the most recent completed assistant turn produced by the same
 * model on this branch, or `undefined` when that id is not a Responses id: the
 * platform rejects an id that does not begin with `resp` with HTTP 400
 * (senpi#2118), while an unknown or expired `resp_` id only yields
 * `comparison_response_not_found` diagnostics.
 */
export function findPromptCacheComparisonResponseId(
	model: Pick<Model<any>, "api" | "provider" | "id">,
	messages: readonly Message[],
): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		if (message.api !== model.api || message.provider !== model.provider || message.model !== model.id) continue;
		if (message.stopReason === "error" || message.stopReason === "aborted") continue;
		if (typeof message.responseId === "string" && message.responseId.length > 0) {
			return message.responseId.startsWith("resp") ? message.responseId : undefined;
		}
	}
	return undefined;
}

export function withPromptCacheComparison(
	options: OpenAIPromptCacheOptionsPayload | undefined,
	comparisonResponseId: string | undefined,
): OpenAIPromptCacheOptionsPayload | undefined {
	if (comparisonResponseId === undefined) return options;
	return { ...options, comparison_response_id: comparisonResponseId };
}

function finiteCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function parsePromptCacheDiagnostics(raw: unknown): PromptCacheDiagnostics | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const record = raw as Record<string, unknown>;
	if (typeof record.type !== "string" || record.type.length === 0) return undefined;
	const diagnostics: PromptCacheDiagnostics = { type: record.type };
	if (typeof record.reason === "string") diagnostics.reason = record.reason;
	const cacheMissedTokens = finiteCount(record.cache_missed_tokens);
	if (cacheMissedTokens !== undefined) diagnostics.cacheMissedTokens = cacheMissedTokens;
	const comparisonReusableTokens = finiteCount(record.comparison_reusable_tokens);
	if (comparisonReusableTokens !== undefined) diagnostics.comparisonReusableTokens = comparisonReusableTokens;
	return diagnostics;
}
