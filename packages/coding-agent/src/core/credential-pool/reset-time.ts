// When a spent account's usage limit resets, read from the failure text: a JSON
// reset field or reset prose. Returns milliseconds from `nowMs` (0 for a reset
// already past) or undefined when no well-formed reset time is present, so the
// caller keeps its default cooldown.

import { clockResetMs } from "@earendil-works/pi-ai/utils/retry-hint";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// Codex `resets_at` (epoch seconds, openai-codex-responses.ts parseErrorResponse)
// and `reset_after_seconds` (the Codex backend's rate-limit window snapshot).
const RESET_AT_KEYS = new Set(["resets_at"]);
const RESET_AFTER_SECONDS_KEYS = new Set(["reset_after_seconds"]);

// "resets in 3 hours", "try again in 2h 30m", "retry in 45 minutes".
const RELATIVE_RE =
	/\b(?:resets?|try again|retry)\s+in\s+~?((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b(?:\s*,?\s*(?:and\s+)?)?)+)/i;
const RELATIVE_PART_RE = /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi;

export function usageLimitResetMs(text: string, nowMs: number): number | undefined {
	return usageLimitReset(text, nowMs)?.ms;
}

/** The reset with its kind: `absolute` names a moment (resets_at, "resets 3pm"); `relative` a duration. */
export function usageLimitReset(
	text: string,
	nowMs: number,
): { readonly ms: number; readonly kind: "absolute" | "relative" } | undefined {
	const json = fromJsonFields(text, nowMs);
	if (json !== undefined) return { ms: json, kind: "absolute" };
	const relative = fromRelativeProse(text);
	if (relative !== undefined) return { ms: relative, kind: "relative" };
	// "resets 12am (Asia/Seoul)": the same clock reader the retry-hint extractor uses (senpi#1771).
	const clock = clockResetMs(text, nowMs);
	return clock === undefined ? undefined : { ms: clock, kind: "absolute" };
}

function fromJsonFields(text: string, nowMs: number): number | undefined {
	const start = text.indexOf("{");
	if (start < 0) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start));
	} catch {
		return undefined;
	}
	let found: number | undefined;
	walk(parsed, (key, value) => {
		const ms = RESET_AT_KEYS.has(key)
			? absoluteFieldMs(value, nowMs)
			: RESET_AFTER_SECONDS_KEYS.has(key)
				? secondsFieldMs(value)
				: undefined;
		if (ms !== undefined && (found === undefined || ms > found)) found = ms;
	});
	return found;
}

function walk(value: unknown, visit: (key: string, value: unknown) => void): void {
	if (Array.isArray(value)) {
		for (const item of value) walk(item, visit);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	for (const [key, entry] of Object.entries(value)) {
		visit(key, entry);
		walk(entry, visit);
	}
}

function absoluteFieldMs(value: unknown, nowMs: number): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		const epochMs = value < 1e12 ? value * 1000 : value;
		return Math.max(0, Math.ceil(epochMs - nowMs));
	}
	if (typeof value === "string" && /\d{4}-\d{2}-\d{2}T/.test(value)) {
		const epochMs = Date.parse(value);
		return Number.isNaN(epochMs) ? undefined : Math.max(0, epochMs - nowMs);
	}
	return undefined;
}

function secondsFieldMs(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.ceil(value * 1000) : undefined;
}

function fromRelativeProse(text: string): number | undefined {
	const phrase = RELATIVE_RE.exec(text)?.[1];
	if (phrase === undefined) return undefined;
	let total = 0;
	for (const [, amount, unit] of phrase.matchAll(RELATIVE_PART_RE)) {
		total += Number.parseFloat(amount ?? "0") * unitMs(unit ?? "");
	}
	return Math.ceil(total);
}

function unitMs(unit: string): number {
	const u = unit.toLowerCase();
	if (u.startsWith("d")) return DAY_MS;
	if (u.startsWith("h")) return HOUR_MS;
	if (u === "s" || u.startsWith("sec")) return 1000;
	return MINUTE_MS;
}
