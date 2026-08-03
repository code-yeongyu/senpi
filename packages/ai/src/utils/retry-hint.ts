/**
 * Strict 429 retry-hint extractor with canonical marker helpers.
 *
 * Precedence (first match wins, malformed source falls through):
 *   1. retry-after-ms header  (strict `^\d+(?:\.\d+)?$`, ceil)
 *   2. retry-after header      (strict integer delta-seconds `^\d+$`, else HTTP-date)
 *   3. x-ratelimit-reset{,-requests,-tokens}  (epoch seconds, max-wins)
 *   4. JSON retryDelay strings (ms/s/m units, recursive, max-wins; numeric rejected)
 *   5. body prose              (ms-marker, seconds-marker, relative, resets-at ISO8601)
 *
 * Eligibility gate: status 429 OR body marks rate-limit error.
 * Explicit zero = 0 (beats lower-precedence positives).
 * Past absolute times clamp to 0.
 * Absolute times resolve against response Date header (clock-skew safe), else nowMs.
 */

const MARKER_RE = /\(retry-after-ms: (\d+)\)$/;
const RATE_LIMIT_BODY_RE =
	/\b(rate_limit_error|rate_limit_exceeded|too_many_requests|resource_exhausted|rate limit (?:exceeded|hit)|too many requests)\b/i;
const RATE_LIMIT_JSON_VALUES = new Set([
	"rate_limit_error",
	"rate_limit_exceeded",
	"too_many_requests",
	"resource_exhausted",
]);
const RETRY_AFTER_MS_RE = /^\d+(?:\.\d+)?$/;
const DELTA_SECONDS_RE = /^\d+$/;

/* ---------- public types ---------- */

export interface RetryHintInput {
	status?: number;
	headers?: Headers;
	bodyText: string;
}

/* ---------- eligibility ---------- */

function isRateLimited(status: number | undefined, bodyText: string): boolean {
	if (status === 429) return true;
	if (RATE_LIMIT_BODY_RE.test(bodyText)) return true;
	// JSON type/code fields or retryDelay presence (rate-limit signal)
	const json = tryParseJSON(bodyText);
	if (json !== undefined) {
		const found = scanValue(json, (v, k) => {
			if (k !== undefined && k.toLowerCase() === "retrydelay" && typeof v === "string") return true;
			if (typeof v === "string" && RATE_LIMIT_JSON_VALUES.has(v)) return true;
			if (v === 429) return true;
			return false;
		});
		if (found) return true;
	}
	return false;
}

/* ---------- 1. retry-after-ms header ---------- */

function fromRetryAfterMsHeader(h: Headers | undefined): number | undefined {
	const raw = h?.get("retry-after-ms");
	if (raw === null || raw === undefined) return undefined;
	if (!RETRY_AFTER_MS_RE.test(raw)) return undefined;
	const val = Number.parseFloat(raw);
	if (!Number.isFinite(val) || val < 0) return undefined;
	return Math.ceil(val);
}

/* ---------- 2. retry-after header ---------- */

function fromRetryAfterHeader(h: Headers | undefined, nowMs: number): number | undefined {
	const raw = h?.get("retry-after");
	if (raw === null || raw === undefined) return undefined;
	// integer delta-seconds
	if (DELTA_SECONDS_RE.test(raw)) {
		return Number.parseInt(raw, 10) * 1000;
	}
	// HTTP-date — must contain alphabetic chars to be a real date string
	if (/[a-zA-Z]/.test(raw)) {
		const parsed = Date.parse(raw);
		if (!Number.isNaN(parsed)) {
			const base = dateHeaderMs(h) ?? nowMs;
			return clampAbsolute(parsed, base);
		}
	}
	return undefined;
}

/* ---------- 3. x-ratelimit-reset* headers ---------- */

function fromXRateLimitReset(h: Headers | undefined, nowMs: number): number | undefined {
	let best: number | undefined;
	for (const key of ["x-ratelimit-reset", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]) {
		const raw = h?.get(key);
		if (raw === null || raw === undefined) continue;
		const epoch = Number.parseFloat(raw);
		if (!Number.isFinite(epoch) || epoch < 0) continue;
		// reject "12abc" — strict number check
		if (!/^\d+(?:\.\d+)?$/.test(raw)) continue;
		const delta = Math.ceil(epoch * 1000 - nowMs);
		const clamped = Math.max(0, delta);
		if (best === undefined || clamped > best) best = clamped;
	}
	return best;
}

/* ---------- 4. JSON retryDelay (recursive, max-wins) ---------- */

const RETRY_DELAY_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|m)$/;

function fromJsonRetryDelay(bodyText: string): number | undefined {
	const json = tryParseJSON(bodyText);
	if (json === undefined) return undefined;
	let best: number | undefined;
	scanValue(json, (v) => {
		if (typeof v !== "string") return false;
		const m = v.match(RETRY_DELAY_RE);
		if (!m) return false;
		const num = Number.parseFloat(m[1]);
		const unit = m[2];
		const ms = unit === "ms" ? num : unit === "s" ? num * 1000 : num * 60_000;
		const intMs = Math.ceil(ms);
		if (best === undefined || intMs > best) best = intMs;
		return false; // keep scanning
	});
	return best;
}

/* ---------- 5. body prose ---------- */

function fromBodyProse(bodyText: string, nowMs: number): number | undefined {
	// ms-marker: retry-after-ms: <N>
	let m = bodyText.match(/retry-after-ms:\s*(\d+)/i);
	if (m) return Number.parseInt(m[1], 10);

	// seconds-marker: retry-after: <N>
	m = bodyText.match(/retry-after:\s*(\d+)/i);
	if (m) return Number.parseInt(m[1], 10) * 1000;

	// relative prose: try again | retry | wait after ... [in] N <unit>
	m = bodyText.match(
		/(?:try again|retry|wait after).*?(?:in\s+)?(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?|m|min|minutes?)\b/i,
	);
	if (m) return convertUnit(Number.parseFloat(m[1]), m[2]);

	// resets at <ISO8601-with-tz>
	m = bodyText.match(/resets?\s+at\s+(\S+)/i);
	if (m) {
		const parsed = Date.parse(m[1]);
		if (!Number.isNaN(parsed)) return clampAbsolute(parsed, nowMs);
	}

	return undefined;
}

/* ---------- helpers ---------- */

function dateHeaderMs(h: Headers | undefined): number | undefined {
	const raw = h?.get("date");
	if (raw === null || raw === undefined) return undefined;
	const parsed = Date.parse(raw);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function clampAbsolute(targetMs: number, baseMs: number): number {
	return Math.max(0, targetMs - baseMs);
}

function convertUnit(num: number, unit: string): number {
	const u = unit.toLowerCase();
	if (u === "ms") return Math.ceil(num);
	if (u === "s" || u === "sec" || u === "second" || u === "seconds") return Math.ceil(num * 1000);
	return Math.ceil(num * 60_000); // m / min / minute / minutes
}

/** Recursively walk JSON, calling fn on every leaf value with its key. */
function scanValue(
	value: unknown,
	fn: (v: string | number | boolean | null, key?: string) => boolean,
	key?: string,
): boolean {
	if (value === null) return fn(null, key);
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return fn(value, key);
	if (Array.isArray(value)) {
		for (const item of value) {
			if (scanValue(item, fn, key)) return true;
		}
		return false;
	}
	if (typeof value === "object") {
		for (const [k, v] of Object.entries(value)) {
			if (scanValue(v, fn, k)) return true;
		}
		return false;
	}
	return false;
}

function tryParseJSON(text: string): unknown {
	// strip SSE data: prefix lines
	const cleaned = text.replace(/^data:\s*/gm, "").trim();
	if (!cleaned.startsWith("{") && !cleaned.startsWith("[")) return undefined;
	try {
		return JSON.parse(cleaned);
	} catch {
		return undefined;
	}
}

/* ---------- main extractor ---------- */

export function extract429RetryAfterMs(input: RetryHintInput, nowMs?: number): number | undefined {
	const now = nowMs ?? Date.now();

	if (!isRateLimited(input.status, input.bodyText)) return undefined;

	// 1. retry-after-ms header
	const fromMs = fromRetryAfterMsHeader(input.headers);
	if (fromMs !== undefined) return fromMs;

	// 2. retry-after header
	const fromRa = fromRetryAfterHeader(input.headers, now);
	if (fromRa !== undefined) return fromRa;

	// 3. x-ratelimit-reset* headers
	const fromXrl = fromXRateLimitReset(input.headers, now);
	if (fromXrl !== undefined) return fromXrl;

	// 4. JSON retryDelay
	const fromJson = fromJsonRetryDelay(input.bodyText);
	if (fromJson !== undefined) return fromJson;

	// 5. body prose
	return fromBodyProse(input.bodyText, now);
}

/* ---------- marker helpers ---------- */

export function appendRetryAfterMsMarker(message: string, hintMs: number): string {
	return `${message} (retry-after-ms: ${hintMs})`;
}

export function parseRetryAfterMsMarker(message: string): number | undefined {
	const m = message.match(MARKER_RE);
	if (!m) return undefined;
	return Number.parseInt(m[1], 10);
}
