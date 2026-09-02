import type { StreamFn } from "@earendil-works/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	TextContent,
} from "@earendil-works/pi-ai/compat";
import { completeSimple, type RetryPolicy, retryAssistantCall } from "@earendil-works/pi-ai/compat";

interface SessionTitleAuth {
	readonly apiKey?: string;
	readonly headers?: Record<string, string>;
	readonly extraBody?: Record<string, unknown>;
	readonly env?: Record<string, string>;
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

export async function generateSessionTitle(options: GenerateSessionTitleOptions): Promise<string | undefined> {
	if (shouldSkipSessionTitle(options.firstPrompt)) {
		return undefined;
	}

	// Titles are cosmetic background work: honor the caller's retry policy so a
	// single transient provider error (e.g. a 529 overloaded stream) does not
	// surface as a scary runtime error. Mirrors completeSummarization().
	// Reasoning-mandatory endpoints (e.g. Z.ai GLM 5.x via OpenRouter) reject the
	// reasoning-disabled mapping pi-ai sends when `reasoning` is unset with HTTP
	// 400 "Reasoning is mandatory for this endpoint and cannot be disabled.";
	// retry those once with low reasoning instead of paying reasoning cost on
	// every title call for every provider.
	let response = await retryAssistantCall(
		() =>
			completeTitle(
				options.model,
				buildTitleContext(options.firstPrompt),
				buildTitleOptions(options),
				options.streamFn,
			),
		options.retry,
		options.signal,
	);
	if (response.stopReason === "error" && isReasoningMandatoryError(response.errorMessage)) {
		response = await retryAssistantCall(
			() =>
				completeTitle(
					options.model,
					buildTitleContext(options.firstPrompt),
					buildTitleOptions(options, "low"),
					options.streamFn,
				),
			options.retry,
			options.signal,
		);
	}
	if (response.stopReason === "error") {
		throw new Error(humanizeProviderError(response.errorMessage ?? "Session title generation failed"));
	}
	return parseSessionTitle(response);
}

const REASONING_MANDATORY_PATTERN = /reasoning is mandatory/i;

function isReasoningMandatoryError(errorMessage: string | undefined): boolean {
	return errorMessage !== undefined && REASONING_MANDATORY_PATTERN.test(errorMessage);
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

function buildTitleOptions(
	options: GenerateSessionTitleOptions,
	reasoning?: SimpleStreamOptions["reasoning"],
): SimpleStreamOptions {
	const titleOptions: SimpleStreamOptions = {
		...options.baseOptions,
		sessionId: options.sessionId,
		cacheRetention: options.model.cacheRetention === "none" ? "none" : "short",
		maxTokens: 64,
	};
	if (reasoning !== undefined) {
		// Fallback for reasoning-mandatory endpoints: low reasoning keeps the
		// cosmetic title cheap, and the larger maxTokens leaves room for the
		// `<title>` output once reasoning tokens count against the completion
		// budget. Callers that never see the 400 keep the cheap default above.
		titleOptions.reasoning = reasoning;
		titleOptions.maxTokens = 1024;
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
	const stream = await streamFn(model, context, options);
	return stream.result();
}

function parseSessionTitle(message: AssistantMessage): string | undefined {
	const text = message.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("")
		.trim();
	const match = text.match(/<title>\s*([\s\S]*?)\s*<\/title>/i);
	const rawTitle = match?.[1];
	if (rawTitle === undefined) {
		return undefined;
	}
	const title = sanitizeTitle(rawTitle);
	if (!title || title.toLowerCase() === "none") {
		return undefined;
	}
	return title;
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

function sanitizeTitle(text: string): string {
	return text
		.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\u001b[\u0020-\u002f]*[\u0030-\u007e]/g, "")
		.replace(/[\r\n]+/g, " ")
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.replace(/^["'`]+|["'`.!?]+$/g, "")
		.trim()
		.slice(0, 80)
		.trim();
}
