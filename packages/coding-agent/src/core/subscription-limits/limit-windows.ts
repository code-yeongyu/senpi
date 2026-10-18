/**
 * The limit windows a subscription reports with its responses, read into one shape: which window
 * (5-hour, weekly, ...), how much of it is used, and when it resets. ChatGPT subscriptions (Codex) send
 * `x-codex-primary-*`/`x-codex-secondary-*` headers (percent used, window minutes, reset epoch seconds),
 * one family per metered limit; Claude subscriptions send
 * `anthropic-ratelimit-unified-{5h,7d}-*` headers (utilization as a 0-1 fraction, reset epoch seconds), and
 * the Claude SDK a `rate_limit_event`. A window nothing reported is absent, never 0%.
 */

export interface LimitWindow {
	/** Stable key within an account: `<limit>:<window>` (`codex:primary`, `claude:5h`). */
	readonly id: string;
	/** What the window is, as a person reads it: `5h`, `7d`, `7d opus`. */
	readonly label: string;
	readonly windowMinutes?: number;
	/** 0-100. */
	readonly usedPercent: number;
	/** ISO timestamp. */
	readonly resetsAt?: string;
}

const CODEX_FAMILY = /^x-([a-z0-9-]+)-(?:primary|secondary)-used-percent$/;

function number(value: string | undefined): number | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function iso(epochSeconds: number | undefined): string | undefined {
	return epochSeconds === undefined ? undefined : new Date(epochSeconds * 1000).toISOString();
}

/** `300` -> `5h`, `10080` -> `7d`, otherwise minutes. */
export function windowLabel(minutes: number | undefined, fallback: string): string {
	if (minutes === undefined || minutes <= 0) return fallback;
	if (minutes % 1440 === 0) return `${minutes / 1440}d`;
	if (minutes % 60 === 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}

function lower(headers: Readonly<Record<string, string>>): Map<string, string> {
	return new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

function codexWindow(
	headers: Map<string, string>,
	family: string,
	slot: "primary" | "secondary",
): LimitWindow | undefined {
	const used = number(headers.get(`x-${family}-${slot}-used-percent`));
	if (used === undefined) return undefined;
	const minutes = number(headers.get(`x-${family}-${slot}-window-minutes`));
	const resetAt = number(headers.get(`x-${family}-${slot}-reset-at`));
	// The same rule the Codex client applies: an all-zero window carries no information.
	if (used === 0 && (minutes ?? 0) === 0 && resetAt === undefined) return undefined;
	const limit = family.replace(/-/g, "_");
	const resetsAt = iso(resetAt);
	return {
		id: `${limit}:${slot}`,
		label: limit === "codex" ? windowLabel(minutes, slot) : `${windowLabel(minutes, slot)} ${limit}`,
		...(minutes === undefined ? {} : { windowMinutes: minutes }),
		usedPercent: used,
		...(resetsAt === undefined ? {} : { resetsAt }),
	};
}

/** Every Codex limit family the response headers carry. */
export function codexWindowsFromHeaders(raw: Readonly<Record<string, string>>): LimitWindow[] {
	const headers = lower(raw);
	const families = new Set<string>();
	for (const name of headers.keys()) {
		const family = CODEX_FAMILY.exec(name)?.[1];
		if (family !== undefined) families.add(family);
	}
	return [...families]
		.sort()
		.flatMap((family) =>
			(["primary", "secondary"] as const).flatMap((slot) => codexWindow(headers, family, slot) ?? []),
		);
}

const CLAUDE_WINDOWS = [
	{ key: "5h", minutes: 300 },
	{ key: "7d", minutes: 10080 },
] as const;

/** Claude's unified rate-limit headers (utilization is a 0-1 fraction). */
export function claudeWindowsFromHeaders(raw: Readonly<Record<string, string>>): LimitWindow[] {
	const headers = lower(raw);
	return CLAUDE_WINDOWS.flatMap(({ key, minutes }) => {
		const utilization = number(headers.get(`anthropic-ratelimit-unified-${key}-utilization`));
		if (utilization === undefined) return [];
		const resetsAt = iso(number(headers.get(`anthropic-ratelimit-unified-${key}-reset`)));
		return [
			{
				id: `claude:${key}`,
				label: key,
				windowMinutes: minutes,
				usedPercent: Math.round(utilization * 10_000) / 100,
				...(resetsAt === undefined ? {} : { resetsAt }),
			},
		];
	});
}

const SDK_WINDOWS: Readonly<Record<string, { readonly id: string; readonly label: string; readonly minutes: number }>> =
	{
		five_hour: { id: "claude:5h", label: "5h", minutes: 300 },
		seven_day: { id: "claude:7d", label: "7d", minutes: 10080 },
		seven_day_opus: { id: "claude:7d_opus", label: "7d opus", minutes: 10080 },
		seven_day_sonnet: { id: "claude:7d_sonnet", label: "7d sonnet", minutes: 10080 },
	};

/** The Claude SDK's `rate_limit_event` (`rate_limit_info`: type, 0-1 utilization, reset epoch seconds). */
export function claudeWindowsFromSdkEvent(data: unknown): LimitWindow[] {
	if (typeof data !== "object" || data === null || !("type" in data) || data.type !== "rate_limit_event") return [];
	const info = (data as { rate_limit_info?: { rateLimitType?: unknown; utilization?: unknown; resetsAt?: unknown } })
		.rate_limit_info;
	const window = typeof info?.rateLimitType === "string" ? SDK_WINDOWS[info.rateLimitType] : undefined;
	if (window === undefined || typeof info?.utilization !== "number") return [];
	const resetsAt = iso(typeof info.resetsAt === "number" ? info.resetsAt : undefined);
	return [
		{
			id: window.id,
			label: window.label,
			windowMinutes: window.minutes,
			usedPercent: Math.round(info.utilization * 10_000) / 100,
			...(resetsAt === undefined ? {} : { resetsAt }),
		},
	];
}
