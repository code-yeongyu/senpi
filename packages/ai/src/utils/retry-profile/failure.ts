import { extract429RetryAfterMs } from "../retry-hint.ts";
import type { RetryFailure, RetryFailureKind } from "./types.ts";

export interface RetryFailureContext {
	/** Raw response/error body text captured at the catch boundary, when held. */
	readonly bodyText?: string;
}

const MAX_MESSAGE_CHARS = 500;

const QUOTA_WORDING_PATTERN = /exceeded_current_quota_error|insufficient\s+balance|credits?_required|quota|billing/i;
const IMAGE_FORMAT_PATTERN =
	/unsupported image format|unsupported media type for base64 image|invalid data url for image/i;

/**
 * Anthropic SDK connection-error classes are matched by constructor name
 * rather than `instanceof`: a static import of the SDK error classes would
 * break every test that `vi.mock`s `@anthropic-ai/sdk` without re-exporting
 * them, and the SDK never sets `error.name`. `APIConnectionTimeoutError`
 * extends `APIConnectionError`, so callers must check the timeout name first.
 */
function sdkErrorClassName(error: unknown): string | undefined {
	if (!(error instanceof Error)) return undefined;
	const name = error.constructor?.name;
	return typeof name === "string" && name.length > 0 ? name : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ShapedProviderError extends Error {
	readonly status?: unknown;
	readonly headers?: unknown;
	/** Anthropic SDK carries the parsed error body here. */
	readonly error?: unknown;
}

function toShaped(error: unknown): ShapedProviderError | undefined {
	return error instanceof Error ? (error as ShapedProviderError) : undefined;
}

function numericStatus(shaped: ShapedProviderError | undefined): number | undefined {
	const status = shaped?.status;
	return typeof status === "number" && Number.isFinite(status) ? status : undefined;
}

function headerObject(shaped: ShapedProviderError | undefined): Headers | undefined {
	return shaped?.headers instanceof Headers ? shaped.headers : undefined;
}

/** Nested `error.type` / `error.code` strings from a parsed provider body, in order. */
function nestedProviderCodes(body: unknown): readonly string[] | undefined {
	if (!isRecord(body)) return undefined;
	const inner = body.error;
	if (!isRecord(inner)) return undefined;
	const codes: string[] = [];
	for (const key of ["type", "code"] as const) {
		const value = inner[key];
		if (typeof value === "string" && value.length > 0) codes.push(value);
	}
	return codes.length > 0 ? codes : undefined;
}

/** Parse the leading JSON object of an SSE error payload, ignoring trailing markers. */
function parseLeadingJson(text: string): unknown {
	const candidate = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
	if (!candidate.startsWith("{") || !candidate.endsWith("}")) return undefined;
	try {
		return JSON.parse(candidate) as unknown;
	} catch {
		return undefined;
	}
}

function quotaWording(shaped: ShapedProviderError | undefined, bodyText: string): boolean {
	const candidates = [shaped?.message, bodyText];
	return candidates.some((text) => typeof text === "string" && QUOTA_WORDING_PATTERN.test(text));
}

/**
 * Normalize a raw anthropic-messages failure into whitelisted
 * {@link RetryFailure} facts. Raw headers, bodies, and credentials are never
 * retained: only the eight declared fields, each derived from parsed facts.
 */
export function normalizeAnthropicRetryFailure(error: unknown, context?: RetryFailureContext): RetryFailure {
	const message = error instanceof Error ? error.message : String(error);
	const shaped = toShaped(error);
	const status = numericStatus(shaped);
	const headers = headerObject(shaped);
	const bodyText = context?.bodyText ?? message;

	let kind: RetryFailureKind;
	let providerCodes: readonly string[] | undefined;

	if (error instanceof Error && error.name === "AbortError") {
		kind = "abort";
	} else if (sdkErrorClassName(error) === "APIConnectionTimeoutError") {
		kind = "timeout";
	} else if (sdkErrorClassName(error) === "APIConnectionError") {
		kind = "connection";
	} else if (typeof message === "string" && IMAGE_FORMAT_PATTERN.test(message)) {
		kind = "image-format";
	} else if (status !== undefined) {
		kind = status === 429 && quotaWording(shaped, bodyText) ? "quota-exhausted" : "http-status";
		providerCodes = nestedProviderCodes(shaped?.error);
	} else {
		const parsed = parseLeadingJson(bodyText);
		providerCodes = nestedProviderCodes(parsed);
		kind = providerCodes !== undefined ? "provider" : "unknown";
	}

	const retryAfterMs = extract429RetryAfterMs({ status, headers, bodyText });

	const shouldRetryHeader = headers?.get("x-should-retry");
	const shouldRetry = shouldRetryHeader === "true" ? true : shouldRetryHeader === "false" ? false : undefined;

	return {
		origin: "anthropic-messages",
		kind,
		message: message.slice(0, MAX_MESSAGE_CHARS),
		...(status !== undefined ? { statusCode: status } : {}),
		...(providerCodes !== undefined ? { providerCodes } : {}),
		...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
		...(shouldRetry !== undefined ? { shouldRetry } : {}),
	};
}
