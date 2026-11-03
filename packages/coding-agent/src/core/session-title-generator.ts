import type { StreamFn } from "@earendil-works/pi-agent-core";
import { normalizeContext } from "@earendil-works/pi-ai";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	ThinkingLevel,
} from "@earendil-works/pi-ai/compat";
import { completeSimple, type RetryPolicy, retryAssistantCall } from "@earendil-works/pi-ai/compat";
import { withoutServerSearch } from "./extensions/builtin/server-search-fallback.ts";
import { readTitleAnswer, type SessionTitleOutcome, type TitleAnswer, titleOutcome } from "./session-title-answer.ts";
import { initialTitleReasoning, mandatoryReasoningRetryLevel } from "./session-title-reasoning.ts";

interface SessionTitleAuth {
	readonly apiKey?: string;
	readonly headers?: Record<string, string>;
	readonly extraBody?: Record<string, unknown>;
	readonly env?: Record<string, string>;
}

interface TitleRequest {
	readonly reasoning: ThinkingLevel | undefined;
	readonly maxTokens: number;
}

interface GenerateSessionTitleOptions {
	readonly firstPrompt: string;
	readonly model: Model<Api>;
	readonly auth: SessionTitleAuth;
	readonly sessionId: string;
	readonly baseOptions?: SimpleStreamOptions;
	readonly signal?: AbortSignal;
	readonly streamFn?: StreamFn;
	readonly retry?: RetryPolicy;
}

const TITLE_SYSTEM_PROMPT = `Generate a concise title for this coding-agent session.

Rules:
- Use 3 to 6 words.
- Prefer concrete nouns and verbs from the user's task.
- Do not include quotes, punctuation at the end, markdown, or explanations.
- If the input is only a greeting, acknowledgement, or too vague to title, return <title>none</title>.
- Respond only as <title>Session Title</title>.`;

const LOW_SIGNAL_PROMPTS = new Set([
	"hi",
	"hello",
	"hey",
	"yo",
	"thanks",
	"thank you",
	"ok",
	"okay",
	"k",
	"yes",
	"no",
	"yep",
	"nope",
]);

const TITLE_MAX_TOKENS = 64;
// Reasoning tokens count against the completion budget, so a title that must reason needs room
// for the thinking and the `<title>` answer. A model that thinks although no level was sent (a gateway
// that cannot turn thinking off) gets this budget on one retry after it spends the small one (#5471).
const REASONING_TITLE_MAX_TOKENS = 1024;

const MAX_TITLE_RETRIES = 1;
const MAX_TITLE_RETRY_DELAY_MS = 2000;

/**
 * Narrow the user's retry budget for cosmetic background title generation.
 *
 * A title is not worth the full agent-turn budget: the default policy would
 * keep hitting an already-overloaded provider for ~14s while the user's real
 * turn competes for the same capacity, and a custom `baseDelayMs` could stall
 * it far longer. One retry recovers the common single-blip case; a title that
 * still fails is regenerated at the next turn end anyway. `enabled` stays the
 * user's call, and a smaller configured budget is never inflated.
 */
export function sessionTitleRetryPolicy(settings: RetryPolicy): RetryPolicy {
	return {
		enabled: settings.enabled,
		maxRetries: Math.min(settings.maxRetries, MAX_TITLE_RETRIES),
		baseDelayMs: Math.min(settings.baseDelayMs, MAX_TITLE_RETRY_DELAY_MS),
	};
}

export function shouldSkipSessionTitle(text: string): boolean {
	const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
	if (normalized.length === 0) return true;
	if (normalized.startsWith("/")) return true;
	return LOW_SIGNAL_PROMPTS.has(normalized);
}

export async function generateSessionTitle(options: GenerateSessionTitleOptions): Promise<SessionTitleOutcome> {
	if (shouldSkipSessionTitle(options.firstPrompt)) {
		return { kind: "untitled" };
	}

	// Titles are cosmetic background work: honor the caller's retry policy so a
	// single transient provider error (e.g. a 529 overloaded stream) does not
	// surface as a scary runtime error. Mirrors completeSummarization().
	const reasoning = initialTitleReasoning(options.model);
	let request: TitleRequest = { reasoning, maxTokens: titleBudget(reasoning) };
	let response = await requestTitle(options, request);
	const retryReasoning =
		response.stopReason === "error"
			? mandatoryReasoningRetryLevel(options.model, reasoning, response.errorMessage)
			: undefined;
	if (retryReasoning !== undefined) {
		request = { reasoning: retryReasoning, maxTokens: titleBudget(retryReasoning) };
		response = await requestTitle(options, request);
	}
	let answer = settledAnswer(response);
	if (
		answer.kind === "no-answer" &&
		response.stopReason === "length" &&
		request.maxTokens < REASONING_TITLE_MAX_TOKENS
	) {
		request = { reasoning: request.reasoning, maxTokens: REASONING_TITLE_MAX_TOKENS };
		response = await requestTitle(options, request);
		answer = settledAnswer(response);
	}
	return titleOutcome(answer, options.firstPrompt, response, request.maxTokens);
}

function titleBudget(reasoning: ThinkingLevel | undefined): number {
	return reasoning === undefined ? TITLE_MAX_TOKENS : REASONING_TITLE_MAX_TOKENS;
}

function settledAnswer(response: AssistantMessage): TitleAnswer {
	if (response.stopReason === "error") {
		throw new Error(humanizeProviderError(response.errorMessage ?? "Session title generation failed"));
	}
	return readTitleAnswer(response);
}

function requestTitle(options: GenerateSessionTitleOptions, request: TitleRequest): Promise<AssistantMessage> {
	return retryAssistantCall(
		() =>
			completeTitle(
				options.model,
				buildTitleContext(options.firstPrompt),
				buildTitleOptions(options, request),
				options.streamFn,
			),
		options.retry,
		options.signal,
	);
}

function buildTitleContext(firstPrompt: string): Context {
	return {
		systemPrompt: TITLE_SYSTEM_PROMPT,
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: firstPrompt }],
				timestamp: Date.now(),
			},
		],
	};
}

function buildTitleOptions(options: GenerateSessionTitleOptions, request: TitleRequest): SimpleStreamOptions {
	const { reasoning, maxTokens } = request;
	const titleOptions: SimpleStreamOptions = {
		...options.baseOptions,
		onPayload: withoutServerSearch(options.baseOptions?.onPayload),
		sessionId: options.sessionId,
		cacheRetention: options.model.cacheRetention === "none" ? "none" : "short",
		maxTokens,
	};
	if (reasoning !== undefined) {
		titleOptions.reasoning = reasoning;
	}
	if (options.auth.apiKey !== undefined) {
		titleOptions.apiKey = options.auth.apiKey;
	}
	if (options.auth.headers !== undefined) {
		titleOptions.headers = options.auth.headers;
	}
	if (options.auth.extraBody !== undefined) {
		titleOptions.extraBody = options.auth.extraBody;
	}
	if (options.auth.env !== undefined) {
		titleOptions.env = options.auth.env;
	}
	if (options.signal !== undefined) {
		titleOptions.signal = options.signal;
	}
	return titleOptions;
}

async function completeTitle(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	if (streamFn === undefined) {
		return completeSimple(model, context, options);
	}
	const stream = await streamFn(model, normalizeContext(context), options);
	return stream.result();
}

/**
 * Reduce a raw provider error payload (e.g. an Anthropic `{"type":"error",...}`
 * body, optionally prefixed with an HTTP status code) to a short human-readable
 * line while keeping the error type and request id for follow-up. Non-JSON and
 * unrecognized payloads pass through unchanged.
 */
export function humanizeProviderError(raw: string): string {
	// `formatProviderError` (packages/ai/src/utils/error-body.ts) emits
	// `<status>: <body>` or `<prefix> (<status>): <body>`; Anthropic SSE error
	// events arrive as the bare JSON body.
	const statusPrefix = raw.trim().match(/^(?:.*?\((\d{3})\)|(\d{3}))\s*:\s*(?=\{)/);
	const status = statusPrefix?.[1] ?? statusPrefix?.[2];
	const bodyText = statusPrefix ? raw.trim().slice(statusPrefix[0].length) : raw.trim();
	if (!bodyText.startsWith("{")) {
		return raw;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		return raw;
	}
	const body = asRecord(parsed);
	if (!body) {
		return raw;
	}
	const nested = asRecord(body.error);
	const message = asNonEmptyString(nested?.message) ?? asNonEmptyString(body.message) ?? asNonEmptyString(body.error);
	if (message === undefined) {
		return raw;
	}
	const details: string[] = [];
	const errorType = asNonEmptyString(nested?.type) ?? asNonEmptyString(body.type);
	if (errorType && errorType !== "error") {
		details.push(errorType);
	}
	if (status) {
		details.push(`HTTP ${status}`);
	}
	const requestId = asNonEmptyString(body.request_id);
	if (requestId) {
		details.push(`request ${requestId}`);
	}
	return details.length > 0 ? `${message} (${details.join(", ")})` : message;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
