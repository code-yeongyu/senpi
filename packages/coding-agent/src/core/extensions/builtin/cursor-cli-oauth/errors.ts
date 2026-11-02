export type CursorCliErrorKind =
	| "binary_missing"
	| "invalid_api_key"
	| "keychain_locked"
	| "invalid_model"
	| "rate_limit"
	| "auth_error"
	| "context_overflow"
	| "network"
	| "malformed_stream"
	| "other";

export type CursorCliErrorClassification = {
	kind: CursorCliErrorKind;
	retryable: boolean;
	blockMs?: number;
};

export type CursorCliErrorInput = {
	exitCode?: unknown;
	stderr?: unknown;
	resultEvent?: unknown;
	thrown?: unknown;
};

export const DEFAULT_RATE_LIMIT_BLOCK_MS = 60_000;
export const MAX_RATE_LIMIT_BLOCK_MS = 48 * 60 * 60 * 1_000;

/** Add each probe-observed Cursor context failure as one exact line. */
export const CURSOR_CONTEXT_OVERFLOW_WORDINGS: readonly string[] = [];

const OTHER_ERROR: CursorCliErrorClassification = { kind: "other", retryable: false };
const MAX_TEXT_DEPTH = 5;
const MAX_TEXT_VALUES = 100;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function collectText(value: unknown, output: string[], seen: Set<object>, depth: number): void {
	if (output.length >= MAX_TEXT_VALUES || depth > MAX_TEXT_DEPTH) return;
	if (typeof value === "string") {
		output.push(value);
		return;
	}
	if (value instanceof Error) {
		output.push(value.message);
	}
	if (value === null || typeof value !== "object" || seen.has(value)) return;
	seen.add(value);
	for (const nested of Object.values(value)) {
		collectText(nested, output, seen, depth + 1);
		if (output.length >= MAX_TEXT_VALUES) return;
	}
}

function errorText(input: CursorCliErrorInput): string {
	const parts: string[] = [];
	const seen = new Set<object>();
	collectText(input.stderr, parts, seen, 0);
	collectText(input.resultEvent, parts, seen, 0);
	collectText(input.thrown, parts, seen, 0);
	return parts.join("\n");
}

function errorLines(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function hasExactLine(lines: readonly string[], wording: string): boolean {
	return lines.some((line) => line === wording);
}

function hasTypedKind(value: unknown, kind: CursorCliErrorKind): boolean {
	return record(value)?.kind === kind;
}

function positiveNumber(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
	return Math.ceil(value);
}

function findRetryAfterMs(value: unknown, seen: Set<object>, depth: number): number | undefined {
	if (depth > MAX_TEXT_DEPTH || value === null || typeof value !== "object" || seen.has(value)) return undefined;
	seen.add(value);
	const object = record(value);
	if (object) {
		const direct = positiveNumber(object.retryAfterMs) ?? positiveNumber(object.retry_after_ms);
		if (direct !== undefined) return direct;
	}
	for (const nested of Object.values(value)) {
		const found = findRetryAfterMs(nested, seen, depth + 1);
		if (found !== undefined) return found;
	}
	return undefined;
}

function retryAfterMs(input: CursorCliErrorInput, text: string): number | undefined {
	const structured =
		findRetryAfterMs(input.resultEvent, new Set<object>(), 0) ?? findRetryAfterMs(input.thrown, new Set<object>(), 0);
	if (structured !== undefined) return structured;
	const milliseconds = text.match(/\bretry[-_ ]?after[-_ ]?ms\s*[:=]\s*(\d+(?:\.\d+)?)/i);
	if (milliseconds) return Math.ceil(Number(milliseconds[1]));
	const seconds = text.match(/\bretry[-_ ]?after\s*[:=]\s*(\d+(?:\.\d+)?)/i);
	return seconds ? Math.ceil(Number(seconds[1]) * 1_000) : undefined;
}

function rateLimitBlockMs(input: CursorCliErrorInput, text: string): number {
	return Math.min(MAX_RATE_LIMIT_BLOCK_MS, retryAfterMs(input, text) ?? DEFAULT_RATE_LIMIT_BLOCK_MS);
}

/** Classifies observed cursor-agent stderr, result events, and typed transport failures. */
export function classifyCursorCliError(input: CursorCliErrorInput | null | undefined): CursorCliErrorClassification {
	if (!input || typeof input !== "object") return OTHER_ERROR;
	if (hasTypedKind(input.thrown, "binary_missing")) return { kind: "binary_missing", retryable: false };
	if (hasTypedKind(input.thrown, "malformed_stream") || hasTypedKind(input.resultEvent, "malformed_stream")) {
		return { kind: "malformed_stream", retryable: false };
	}

	const text = errorText(input);
	const lines = errorLines(text);
	if (
		hasExactLine(lines, "The provided API key is invalid.") &&
		hasExactLine(lines, "The API key was loaded from the CURSOR_API_KEY environment variable.")
	) {
		return { kind: "invalid_api_key", retryable: false };
	}
	if (hasExactLine(lines, "Error: Your macOS login keychain is locked.")) {
		return { kind: "keychain_locked", retryable: false };
	}
	if (lines.some((line) => /^(?:Error:\s*)?Invalid model value:\s+\S.*$/.test(line))) {
		return { kind: "invalid_model", retryable: false };
	}
	if (/\b(?:HTTP\s*)?429\b|\brate[ _-]?limit(?:ed|ing)?\b|\btoo many requests\b/i.test(text)) {
		return { kind: "rate_limit", retryable: true, blockMs: rateLimitBlockMs(input, text) };
	}
	if (/\b(?:HTTP\s*)?401\b|\bunauthori[sz]ed\b|\bauthentication (?:failed|required)\b|\bnot logged in\b/i.test(text)) {
		return { kind: "auth_error", retryable: false };
	}
	if (
		CURSOR_CONTEXT_OVERFLOW_WORDINGS.some(
			(wording) => hasExactLine(lines, wording) || hasExactLine(lines, `Error: ${wording}`),
		)
	) {
		return { kind: "context_overflow", retryable: false };
	}
	if (
		/\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN)\b|\bnetwork error\b|\bconnection (?:reset|refused|lost)\b|\bsocket hang up\b|\bfetch failed\b/i.test(
			text,
		)
	) {
		return { kind: "network", retryable: true };
	}
	return OTHER_ERROR;
}
