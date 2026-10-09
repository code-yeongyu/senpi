// When a spent account's usage limit resets, read from the failure text: a JSON
// reset field or reset prose. Returns milliseconds from `nowMs` (0 for a reset
// already past) or undefined when no well-formed reset time is present, so the
// caller keeps its default cooldown.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Codex `resets_at` (epoch seconds, openai-codex-responses.ts parseErrorResponse)
// and `reset_after_seconds` (the Codex backend's rate-limit window snapshot).
const RESET_AT_KEYS = new Set(["resets_at"]);
const RESET_AFTER_SECONDS_KEYS = new Set(["reset_after_seconds"]);

// "resets in 3 hours", "try again in 2h 30m", "retry in 45 minutes".
const RELATIVE_RE =
	/\b(?:resets?|try again|retry)\s+in\s+~?((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b(?:\s*,?\s*(?:and\s+)?)?)+)/i;
const RELATIVE_PART_RE = /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi;

// "resets 12am (Asia/Seoul)", "resets Oct 2, 9am", "try again at 12:00 AM".
const CLOCK_RE =
	/\b(?:resets?|try again)\s+(?:at\s+|on\s+)?(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\b\.?(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*)\))?/i;

export function usageLimitResetMs(text: string, nowMs: number): number | undefined {
	return fromJsonFields(text, nowMs) ?? fromRelativeProse(text) ?? fromClockProse(text, nowMs);
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

function fromClockProse(text: string, nowMs: number): number | undefined {
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
