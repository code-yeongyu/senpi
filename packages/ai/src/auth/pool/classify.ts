export type PoolFailureAction = "rotate" | "retry" | "fail";

export type PoolBlockReason = "auth_error" | "rate_limit";

export type PoolFailureClassification = {
	action: PoolFailureAction;
	blockReason?: PoolBlockReason;
	retryAfterMs?: number;
};

const MAX_NESTING_DEPTH = 3;

function fieldOf(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null) return undefined;
	const entry = Object.entries(value).find(([candidate]) => candidate === key);
	return entry?.[1];
}

function statusOf(error: unknown, depth = 0): number | undefined {
	if (depth >= MAX_NESTING_DEPTH) return undefined;
	for (const key of ["status", "statusCode"]) {
		const value = fieldOf(error, key);
		if (typeof value === "number") return value;
	}
	const nested = fieldOf(error, "error");
	return nested === undefined ? undefined : statusOf(nested, depth + 1);
}

function messageOf(error: unknown, depth = 0): string {
	if (typeof error === "string") return error;
	if (error instanceof Error) return error.message;
	if (depth >= MAX_NESTING_DEPTH) return String(error);
	const message = fieldOf(error, "message");
	if (typeof message === "string") return message;
	const nested = fieldOf(error, "error");
	return nested === undefined ? String(error) : messageOf(nested, depth + 1);
}

function retryAfterMsOf(error: unknown, text: string): number | undefined {
	const explicit = fieldOf(error, "retryAfterMs");
	if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) return Math.ceil(explicit);
	const milliseconds = text.match(/\bretry[-_ ]?after[-_ ]?ms\s*[:=]\s*(\d+(?:\.\d+)?)/i);
	if (milliseconds?.[1] !== undefined) return Math.ceil(Number(milliseconds[1]));
	const seconds = text.match(/\bretry[-_ ]?after\s*[:=]\s*(\d+(?:\.\d+)?)/i);
	return seconds?.[1] === undefined ? undefined : Math.ceil(Number(seconds[1]) * 1_000);
}

const RATE_LIMIT_TEXT = /rate.?limit|resource_exhausted|quota|too many requests|overloaded/i;
const AUTH_TEXT = /invalid.?api.?key|unauthorized|authentication|forbidden|token (?:is )?expired|revoked/i;
const TRANSIENT_TEXT =
	/econnreset|econnrefused|etimedout|socket hang up|fetch failed|network error|internal server error|service unavailable|bad gateway|gateway timeout/i;

function rotateOnRateLimit(error: unknown, text: string): PoolFailureClassification {
	const retryAfterMs = retryAfterMsOf(error, text);
	return retryAfterMs === undefined
		? { action: "rotate", blockReason: "rate_limit" }
		: { action: "rotate", blockReason: "rate_limit", retryAfterMs };
}

/**
 * Three-way in-lane failure taxonomy. Rotation is reserved for failures another
 * account can plausibly absorb (rate/capacity and per-account auth); transient
 * transport failures stay on the same slot for the outer retry policy, and
 * everything unrecognized default-denies to `fail` so the model fallback chain
 * above this engine keeps owning unknown errors.
 */
export function classifyPoolFailure(error: unknown): PoolFailureClassification {
	const text = messageOf(error);
	const status = statusOf(error);
	if (status === 429 || status === 529) return rotateOnRateLimit(error, text);
	if (status === 401 || status === 403) return { action: "rotate", blockReason: "auth_error" };
	if (status !== undefined && status >= 500 && status < 600) return { action: "retry" };
	if (RATE_LIMIT_TEXT.test(text)) return rotateOnRateLimit(error, text);
	if (AUTH_TEXT.test(text)) return { action: "rotate", blockReason: "auth_error" };
	if (TRANSIENT_TEXT.test(text)) return { action: "retry" };
	return { action: "fail" };
}
