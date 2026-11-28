import { applyAccountOrder } from "@earendil-works/pi-ai/auth/pool/select";
import type { AccountLimits } from "../subscription-limits/limit-store.ts";

const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
const WEEKLY_TIE_MAX_PERCENTAGE_POINTS = 5;
const WEEKLY_TIE_MAX_READING_AGE_MS = 15 * 60_000;
const WEEKLY_TIE_EARLY_RESET_MS = 24 * 60 * 60_000;

type WeeklyCapacity = {
	readonly usedPercent: number;
	readonly resetsAt: number;
};

export type AccountStrategy = "cache-affine" | "fill-first" | "round-robin";

export function parseAccountStrategy(value: unknown, field: string): AccountStrategy | undefined {
	switch (value) {
		case undefined:
		case "cache-affine":
		case "fill-first":
		case "round-robin":
			return value;
		default:
			throw new Error(`${field} must be "cache-affine", "fill-first", or "round-robin"`);
	}
}

function freshLimits(limits: AccountLimits | undefined, now: number): AccountLimits | undefined {
	if (limits === undefined) return undefined;
	for (const window of limits.windows) {
		if (window.resetsAt !== undefined && Date.parse(window.resetsAt) <= now) continue;
		const reportedAt = Date.parse(limits.windowReportedAt?.[window.id] ?? limits.reportedAt);
		if (!Number.isFinite(reportedAt) || now - reportedAt > WEEKLY_TIE_MAX_READING_AGE_MS) {
			return undefined;
		}
	}
	return limits;
}

function weeklyCapacity(limits: AccountLimits, now: number): WeeklyCapacity | undefined {
	let selected: WeeklyCapacity | undefined;
	for (const window of limits.windows) {
		if (window.windowMinutes !== WEEKLY_WINDOW_MINUTES || !Number.isFinite(window.usedPercent)) continue;
		const resetsAt = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
		if (!Number.isFinite(resetsAt) || resetsAt <= now) continue;
		if (
			selected === undefined ||
			window.usedPercent > selected.usedPercent ||
			(window.usedPercent === selected.usedPercent && resetsAt < selected.resetsAt)
		) {
			selected = { usedPercent: window.usedPercent, resetsAt };
		}
	}
	return selected;
}

function hasComparableUsage(limits: AccountLimits, now: number): boolean {
	return limits.windows.every(
		(window) =>
			(window.resetsAt !== undefined && Date.parse(window.resetsAt) <= now) ||
			(Number.isFinite(window.usedPercent) && window.usedPercent < 95),
	);
}

function usageIsTied(first: AccountLimits, second: AccountLimits, now: number): boolean {
	if (!hasComparableUsage(first, now) || !hasComparableUsage(second, now)) return false;
	const usage = (limits: AccountLimits): Map<string, number> => {
		const result = new Map<string, number>();
		for (const window of limits.windows) {
			if (window.resetsAt !== undefined && Date.parse(window.resetsAt) <= now) continue;
			result.set(window.id, Math.max(result.get(window.id) ?? 0, Math.floor(window.usedPercent)));
		}
		return result;
	};
	const firstUsage = usage(first);
	const secondUsage = usage(second);
	const ids = new Set([...firstUsage.keys(), ...secondUsage.keys()]);
	return [...ids].every(
		(id) => Math.abs((firstUsage.get(id) ?? 0) - (secondUsage.get(id) ?? 0)) <= WEEKLY_TIE_MAX_PERCENTAGE_POINTS,
	);
}

function preferEarlierWeeklyReset<T extends { readonly name: string }>(
	ordered: readonly T[],
	provider: string,
	limits: readonly AccountLimits[],
	now: number,
): readonly T[] {
	if (ordered.length < 2) return ordered;
	const [first, second] = ordered;
	if (first === undefined || second === undefined) return ordered;
	const firstLimits = freshLimits(
		limits.find((limit) => limit.provider === provider && limit.account === first.name),
		now,
	);
	const secondLimits = freshLimits(
		limits.find((limit) => limit.provider === provider && limit.account === second.name),
		now,
	);
	if (firstLimits === undefined || secondLimits === undefined || !usageIsTied(firstLimits, secondLimits, now)) {
		return ordered;
	}
	const firstCapacity = weeklyCapacity(firstLimits, now);
	const secondCapacity = weeklyCapacity(secondLimits, now);
	if (firstCapacity === undefined || secondCapacity === undefined) return ordered;
	if (secondCapacity.resetsAt >= firstCapacity.resetsAt || secondCapacity.resetsAt > now + WEEKLY_TIE_EARLY_RESET_MS) {
		return ordered;
	}
	return [second, first, ...ordered.slice(2)];
}

/** All strategies share the user's stored order; only cache-affine uses HRW as its base. */
export function orderAccounts<T extends { readonly name: string }>(
	accounts: readonly T[],
	ranked: readonly T[],
	accountOrder: readonly string[] | undefined,
	strategy: AccountStrategy = "cache-affine",
	offset = 0,
): T[] {
	switch (strategy) {
		case "cache-affine":
			return applyAccountOrder(accountOrder, ranked);
		case "fill-first":
			return applyAccountOrder(accountOrder, accounts);
		case "round-robin": {
			const ordered = applyAccountOrder(accountOrder, accounts);
			if (ordered.length === 0) return ordered;
			const start = offset % ordered.length;
			return [...ordered.slice(start), ...ordered.slice(0, start)];
		}
		default: {
			const unsupported: never = strategy;
			throw new Error(`Unknown account strategy: ${unsupported}`);
		}
	}
}

/**
 * Reported usage is a preference, not a block. Preserve the normal order when
 * no account has headroom, and ignore windows that have already reset.
 */
export function preferHeadroom<T extends { readonly name: string }>(
	ordered: readonly T[],
	provider: string,
	limits: readonly AccountLimits[],
	now: number,
	preferredAccount?: string,
	weeklyResetTieBreak = false,
): readonly T[] {
	const preferred = ordered.find((account) => account.name === preferredAccount);
	const normal =
		preferred === undefined ? ordered : [preferred, ...ordered.filter((account) => account !== preferred)];
	const nearLimit = new Set(
		limits
			.filter(
				(limit) =>
					limit.provider === provider &&
					limit.windows.some(
						(window) =>
							window.usedPercent >= 95 &&
							(window.resetsAt === undefined || !(Date.parse(window.resetsAt) <= now)),
					),
			)
			.map((limit) => limit.account),
	);
	const withHeadroom = normal.filter((account) => !nearLimit.has(account.name));
	const selected = withHeadroom.length > 0 ? withHeadroom : normal;
	return weeklyResetTieBreak && preferred === undefined
		? preferEarlierWeeklyReset(selected, provider, limits, now)
		: selected;
}
