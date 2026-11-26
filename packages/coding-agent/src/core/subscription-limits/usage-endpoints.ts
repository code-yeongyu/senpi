/**
 * The usage endpoints subscription providers publish, read into the store's window shape (senpi#3684).
 * Claude answers `GET /api/oauth/usage` with `limits[]` (kind `session` / `weekly_all` / `weekly_scoped`,
 * percent 0-100) or, from older servers, the `five_hour` / `seven_day[_<model>]` pair (utilization 0-100);
 * ChatGPT answers `GET /backend-api/wham/usage` with `rate_limit.{primary,secondary}_window`. Window ids
 * match the ones response headers and the Claude SDK report, so a poll and a turn update the same window.
 */
import type { LimitWindow } from "./limit-windows.ts";
import { windowLabel } from "./limit-windows.ts";

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

export type UsageProvider = "anthropic-subscription" | "chatgpt-subscription";

export interface UsageReading {
	readonly windows: readonly LimitWindow[];
	readonly plan?: string;
}

/** A refused usage request: the status and how long the endpoint asked to be left alone. */
export class UsageHttpError extends Error {
	readonly status: number;
	readonly retryAfterMs: number | undefined;

	constructor(status: number, retryAfterMs: number | undefined) {
		super(`HTTP ${status}`);
		this.name = "UsageHttpError";
		this.status = status;
		this.retryAfterMs = retryAfterMs;
	}
}

export type UsageFetch = (url: string, headers: Readonly<Record<string, string>>) => Promise<unknown>;

const USAGE_TIMEOUT_MS = 10_000;

/** `redirect: "error"`: a redirecting usage endpoint is a login wall, and the bearer token must not follow it. */
export const fetchUsageJson: UsageFetch = async (url, headers) => {
	const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(USAGE_TIMEOUT_MS) });
	if (!response.ok) {
		throw new UsageHttpError(response.status, retryAfterMs(response.headers.get("retry-after"), Date.now()));
	}
	return await response.json();
};

export function retryAfterMs(value: string | null, now: number): number | undefined {
	if (value === null) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
	const delay = Date.parse(value) - now;
	return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}

export async function readUsage(provider: UsageProvider, access: string, fetchJson: UsageFetch): Promise<UsageReading> {
	if (provider === "anthropic-subscription") {
		const payload = await fetchJson(CLAUDE_USAGE_URL, {
			Authorization: `Bearer ${access}`,
			Accept: "application/json",
		});
		return { windows: claudeWindowsFromUsage(payload) };
	}
	const accountId = codexAccountId(access);
	const payload = await fetchJson(CODEX_USAGE_URL, {
		Authorization: `Bearer ${access}`,
		Accept: "application/json",
		...(accountId === undefined ? {} : { "ChatGPT-Account-Id": accountId }),
	});
	return codexUsage(payload);
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: undefined;
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isoInstant(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function claudeWindow(id: string, label: string, percent: number, resetsAt: string | undefined): LimitWindow {
	return {
		id,
		label,
		windowMinutes: id === "claude:5h" ? 300 : 10080,
		usedPercent: percent,
		...(resetsAt ? { resetsAt } : {}),
	};
}

/** `Opus` -> `claude:7d_opus` / `7d opus`, the ids the SDK's `rate_limit_event` uses. */
function scopedWindow(model: string, percent: number, resetsAt: string | undefined): LimitWindow {
	const slug = model.toLowerCase().replace(/[^a-z0-9]+/g, "_");
	return claudeWindow(`claude:7d_${slug}`, `7d ${model.toLowerCase()}`, percent, resetsAt);
}

export function claudeWindowsFromUsage(payload: unknown): LimitWindow[] {
	const data = record(payload);
	const windows: LimitWindow[] = [];
	for (const item of Array.isArray(data?.limits) ? data.limits : []) {
		const limit = record(item);
		const percent = finite(limit?.percent);
		if (limit === undefined || percent === undefined) continue;
		const resetsAt = isoInstant(limit.resets_at);
		if (limit.kind === "session") windows.push(claudeWindow("claude:5h", "5h", percent, resetsAt));
		else if (limit.kind === "weekly_all") windows.push(claudeWindow("claude:7d", "7d", percent, resetsAt));
		else if (limit.kind === "weekly_scoped") {
			const model = record(record(limit.scope)?.model)?.display_name;
			if (typeof model === "string" && model !== "") windows.push(scopedWindow(model, percent, resetsAt));
		}
	}
	if (windows.length > 0) return windows;
	for (const [key, value] of Object.entries(data ?? {})) {
		const utilization = finite(record(value)?.utilization);
		if (utilization === undefined) continue;
		const resetsAt = isoInstant(record(value)?.resets_at);
		if (key === "five_hour") windows.push(claudeWindow("claude:5h", "5h", utilization, resetsAt));
		else if (key === "seven_day") windows.push(claudeWindow("claude:7d", "7d", utilization, resetsAt));
		else if (key.startsWith("seven_day_"))
			windows.push(scopedWindow(key.slice("seven_day_".length), utilization, resetsAt));
	}
	return windows;
}

export function codexUsage(payload: unknown): UsageReading {
	const data = record(payload);
	const rateLimit = record(data?.rate_limit);
	const windows: LimitWindow[] = [];
	for (const slot of ["primary", "secondary"] as const) {
		const window = record(rateLimit?.[`${slot}_window`]);
		const used = finite(window?.used_percent);
		if (window === undefined || used === undefined) continue;
		const seconds = finite(window.limit_window_seconds);
		const minutes = seconds === undefined ? undefined : Math.round(seconds / 60);
		const resetSeconds = finite(window.reset_at);
		windows.push({
			id: `codex:${slot}`,
			label: windowLabel(minutes, slot),
			...(minutes === undefined ? {} : { windowMinutes: minutes }),
			usedPercent: used,
			...(resetSeconds === undefined ? {} : { resetsAt: new Date(resetSeconds * 1000).toISOString() }),
		});
	}
	const plan = data?.plan_type;
	return { windows, ...(typeof plan === "string" && plan !== "" ? { plan } : {}) };
}

/** The ChatGPT account id lives in the access token's claims; a token that will not decode sends none. */
function codexAccountId(token: string): string | undefined {
	const payload = token.split(".")[1];
	if (!payload) return undefined;
	try {
		const claims = record(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
		const auth = record(claims?.["https://api.openai.com/auth"]);
		for (const key of ["chatgpt_account_id", "account_id"]) {
			const value = auth?.[key];
			if (typeof value === "string" && value !== "") return value;
		}
	} catch {
		// An unreadable token may still be accepted; the request just carries no account header.
	}
	return undefined;
}
