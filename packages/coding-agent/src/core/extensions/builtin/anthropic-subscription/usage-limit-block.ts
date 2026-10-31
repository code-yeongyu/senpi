import { usageLimitResetMs } from "../../../credential-pool/reset-time.ts";
import { subscriptionLimits } from "../../../subscription-limits/limit-store.ts";

// The subscription-limit store keys accounts by this provider id (auth-attempt.ts).
const PROVIDER = "anthropic-subscription";
const HOUR_MS = 60 * 60 * 1_000;

/**
 * Claude Code's own account usage-limit errors, anchored at the start of the message: "You've hit
 * your session limit · resets 3pm", "You've reached your 5-hour limit", "Claude AI usage limit
 * reached". Only a window word Claude Code uses may stand before "limit", so a context or rate
 * limit, a warning ("approaching your usage limit") or ordinary prose never takes a long block.
 */
const CLAUDE_USAGE_LIMIT =
	/^(?:You['\u2019]ve|You have) (?:hit|reached) your (?:(session|weekly|daily|monthly|\d+-hour|usage) )?limit(?=$|\s*[\u00b7\u2219.,{(]|\s+resets?\b)|^Claude AI usage limit reached\b/i;
/**
 * Claude Code's structured terminal reason for a spent subscription. `rapid_refill_breaker` is a short burst
 * breaker, not a spent account, so it keeps the short, session-scoped block (senpi#3466).
 */
const TERMINAL_LIMIT_REASON = /\bblocking_limit\b/;
/** A status the error names; a usage limit is a 429, so any other status is not one. */
const NAMED_STATUS = /\b(?:HTTP|status(?: code)?)\s*(\d{3})\b/i;

/** The longest a block may last for each window word: a reset read past it is a misread. */
const WINDOW_MS: Record<string, number> = {
	session: 5 * HOUR_MS,
	daily: 24 * HOUR_MS,
	weekly: 7 * 24 * HOUR_MS,
	monthly: 31 * 24 * HOUR_MS,
};
/** A limit that names no window is capped at the shortest subscription window. */
const UNNAMED_WINDOW_MS = 5 * HOUR_MS;

function namedWindowMs(word: string | undefined): number | undefined {
	if (word === undefined) return undefined;
	const lower = word.toLowerCase();
	const hours = /^(\d+)-hour$/.exec(lower);
	if (hours) return Number(hours[1]) * HOUR_MS;
	return WINDOW_MS[lower];
}

type SpentWindow = { resetMs: number; windowMs: number | undefined };

/** The latest-resetting fully used window the SDK last reported for this account. */
function spentWindow(accountName: string, now: number): SpentWindow | undefined {
	const limits = subscriptionLimits
		.snapshot()
		.find((entry) => entry.provider === PROVIDER && entry.account === accountName);
	let spent: SpentWindow | undefined;
	for (const window of limits?.windows ?? []) {
		if (window.usedPercent < 100 || window.resetsAt === undefined) continue;
		const resetsAt = Date.parse(window.resetsAt);
		if (!Number.isFinite(resetsAt) || resetsAt <= now) continue;
		if (spent === undefined || resetsAt - now > spent.resetMs) {
			spent = {
				resetMs: resetsAt - now,
				windowMs: window.windowMinutes === undefined ? undefined : window.windowMinutes * 60_000,
			};
		}
	}
	return spent;
}

/**
 * Claude Code's own verdict that the account's subscription is spent: its anchored usage-limit prose
 * or its structured terminal reason, under no status other than 429 (senpi#3462, senpi#3466).
 */
export function isConfirmedAccountUsageLimit(text: string): boolean {
	const trimmed = text.trim();
	if (!CLAUDE_USAGE_LIMIT.test(trimmed) && !TERMINAL_LIMIT_REASON.test(trimmed)) return false;
	const status = NAMED_STATUS.exec(trimmed)?.[1];
	return status === undefined || status === "429";
}

/**
 * How long a spent account stays blocked: until the reset its limit names, or the reset its spent
 * window reported, never past the window the limit belongs to. Undefined when the error is not
 * Claude Code's account usage limit or names no reset, so the caller keeps its short default
 * (senpi#3462).
 */
export function usageLimitBlockMs(text: string, accountName: string, now: number): number | undefined {
	const trimmed = text.trim();
	if (!isConfirmedAccountUsageLimit(trimmed)) return undefined;
	const shape = CLAUDE_USAGE_LIMIT.exec(trimmed);
	const window = spentWindow(accountName, now);
	const parsed = usageLimitResetMs(trimmed, now);
	const resetMs = parsed !== undefined && parsed > 0 ? parsed : window?.resetMs;
	if (resetMs === undefined) return undefined;
	const capMs = namedWindowMs(shape?.[1]) ?? window?.windowMs ?? UNNAMED_WINDOW_MS;
	return Math.min(resetMs, capMs);
}
