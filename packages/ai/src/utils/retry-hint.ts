/**
 * Strict 429 retry-hint extractor with canonical marker helpers.
 *
 * Precedence (first match wins, malformed source falls through):
 *   1. retry-after-ms header  (strict `^\d+(?:\.\d+)?$`, ceil)
 *   2. retry-after header      (strict integer delta-seconds `^\d+$`, else HTTP-date)
 *   3. x-ratelimit-reset{,-requests,-tokens}  (epoch seconds, max-wins)
 *   4. JSON retryDelay strings (ms/s/m units, recursive, max-wins; numeric rejected)
 *   5. body prose              (ms-marker, seconds-marker, relative, resets-in, resets-at ISO8601,
 *                              wall clock with an optional zone: "resets 12am (Asia/Seoul)")
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

	// limit prose: [limit will] reset(s) in N <unit>
	m = bodyText.match(/\bresets?\s+in\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?|m|min|minutes?)\b/i);
	if (m) return convertUnit(Number.parseFloat(m[1]), m[2]);

	// resets at <ISO8601-with-tz>
	m = bodyText.match(/resets?\s+at\s+(\S+)/i);
	if (m) {
		const parsed = Date.parse(m[1]);
		if (!Number.isNaN(parsed)) return clampAbsolute(parsed, nowMs);
	}

	// resets <wall clock> [(<IANA zone>)], the shape Claude Code writes (senpi#1771)
	return clockResetMs(bodyText, nowMs);
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

/* ---------- wall-clock reset prose ---------- */

// A reset written as a wall clock: "resets 12am (Asia/Seoul)", "resets Oct 2, 9am", "try again at 12:00 AM".
// Shared with the credential pool (reset-time.ts) so both read the text the same way (senpi#1771). Milliseconds
// from `nowMs` to the next such moment, or undefined; a time with no zone reads in the host's local zone.
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const CLOCK_RE =
	/\b(?:resets?|try again)\s+(?:at\s+|on\s+)?(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\b\.?(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*)\))?/i;

export function clockResetMs(text: string, nowMs: number): number | undefined {
	const match = CLOCK_RE.exec(text);
	if (!match) return undefined;
	const [, monthName, dayText, hourText, minuteText, meridiem, zoneText] = match;
	const hour12 = Number.parseInt(hourText ?? "", 10);
	const minute = minuteText === undefined ? 0 : Number.parseInt(minuteText, 10);
	if (hour12 < 1 || hour12 > 12 || minute > 59) return undefined;
	const hour = (hour12 % 12) + (meridiem?.toLowerCase() === "p" ? 12 : 0);
	const zone = zoneText ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	if (!isValidTimeZone(zone)) return undefined;
	const today = zonedParts(zone, nowMs);

	if (monthName !== undefined) {
		const month = MONTHS.indexOf(monthName.toLowerCase());
		const day = Number.parseInt(dayText ?? "", 10);
		if (month < 0 || day < 1 || day > 31) return undefined;
		let target = zonedToEpoch(zone, today.year, month, day, hour, minute);
		if (target <= nowMs) target = zonedToEpoch(zone, today.year + 1, month, day, hour, minute);
		return target - nowMs;
	}
	let target = zonedToEpoch(zone, today.year, today.month, today.day, hour, minute);
	if (target <= nowMs) target = zonedToEpoch(zone, today.year, today.month, today.day + 1, hour, minute);
	return target - nowMs;
}

function isValidTimeZone(zone: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: zone });
		return true;
	} catch {
		return false;
	}
}

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function zonedParts(zone: string, epochMs: number): ZonedParts {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		hourCycle: "h23",
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		minute: "numeric",
		second: "numeric",
	}).formatToParts(epochMs);
	const get = (type: Intl.DateTimeFormatPartTypes) =>
		Number.parseInt(parts.find((part) => part.type === type)?.value ?? "0", 10);
	return {
		year: get("year"),
		month: get("month") - 1,
		day: get("day"),
		hour: get("hour"),
		minute: get("minute"),
		second: get("second"),
	};
}

function zoneOffsetMs(zone: string, epochMs: number): number {
	const p = zonedParts(zone, epochMs);
	const wallAsUtc = Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second);
	return wallAsUtc - Math.floor(epochMs / 1000) * 1000;
}

/** The instant a wall-clock time in `zone` names; two passes settle a DST boundary. */
function zonedToEpoch(zone: string, year: number, month: number, day: number, hour: number, minute: number): number {
	const wall = Date.UTC(year, month, day, hour, minute);
	const first = wall - zoneOffsetMs(zone, wall);
	return wall - zoneOffsetMs(zone, first);
}
