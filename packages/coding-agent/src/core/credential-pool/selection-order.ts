import { applyAccountOrder } from "@earendil-works/pi-ai/auth/pool/select";
import type { AccountLimits } from "../subscription-limits/limit-store.ts";

export type AccountStrategy = "cache-affine" | "fill-first" | "round-robin" | "most-headroom";

/** The usage readings most-headroom ranks by; other strategies ignore them. */
export type HeadroomReadings = {
	readonly provider: string;
	readonly limits: readonly AccountLimits[];
	readonly now: number;
};

export function parseAccountStrategy(value: unknown, field: string): AccountStrategy | undefined {
	switch (value) {
		case undefined:
		case "cache-affine":
		case "fill-first":
		case "round-robin":
		case "most-headroom":
			return value;
		default:
			throw new Error(`${field} must be "cache-affine", "fill-first", "round-robin", or "most-headroom"`);
	}
}

/**
 * Accounts whose headroom is within this many points of the best one count as equally good, so a burst of
 * new sessions spreads over them by the HRW base order instead of all landing on the single top account
 * before its usage is reported again.
 */
const HEADROOM_TIE_BAND = 10;

/** How far ahead headroom looks: usage in a window that resets within it is partly counted as available. */
const HEADROOM_HORIZON_MS = 5 * 60 * 60 * 1000;

/**
 * All strategies share the user's stored order; cache-affine and most-headroom use HRW as their base.
 * most-headroom then puts the accounts within the tie band of the best headroom first, in that base order,
 * and ranks the rest by headroom.
 */
export function orderAccounts<T extends { readonly name: string }>(
	accounts: readonly T[],
	ranked: readonly T[],
	accountOrder: readonly string[] | undefined,
	strategy: AccountStrategy = "cache-affine",
	offset = 0,
	headroom?: HeadroomReadings,
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
		case "most-headroom": {
			const base = applyAccountOrder(accountOrder, ranked);
			if (headroom === undefined) return base;
			const remaining = new Map(base.map((account) => [account.name, remainingPercent(account.name, headroom)]));
			const headroomOf = (account: T): number => remaining.get(account.name) ?? 0;
			const best = Math.max(...base.map(headroomOf));
			const top = base.filter((account) => headroomOf(account) > best - HEADROOM_TIE_BAND);
			// Array sort is stable, so accounts with equal headroom keep the base order.
			const rest = base
				.filter((account) => !top.includes(account))
				.sort((left, right) => headroomOf(right) - headroomOf(left));
			return [...top, ...rest];
		}
		default: {
			const unsupported: never = strategy;
			throw new Error(`Unknown account strategy: ${unsupported}`);
		}
	}
}

/** A window whose reset time has passed no longer limits the account. */
function isLiveWindow(window: { readonly resetsAt?: string }, now: number): boolean {
	return window.resetsAt === undefined || !(Date.parse(window.resetsAt) <= now);
}

/**
 * Percent a window leaves for the next few hours: what is unused now, plus the used part in proportion to
 * how soon the window resets within the headroom horizon. A five-hour window that resets in 30 minutes
 * barely limits a new session; a weekly window that resets in days counts at face value.
 */
function windowHeadroom(window: { readonly usedPercent: number; readonly resetsAt?: string }, now: number): number {
	const left = 100 - window.usedPercent;
	if (window.resetsAt === undefined) return left;
	const returning = 1 - (Date.parse(window.resetsAt) - now) / HEADROOM_HORIZON_MS;
	return left + window.usedPercent * Math.min(1, Math.max(0, returning));
}

/**
 * Headroom of the account's tightest live window, so an account counts as roomy only when its short and
 * weekly windows both are. An account with no reported usage counts as unused, so a new or never-polled
 * account gets tried and reports its usage.
 */
function remainingPercent(account: string, { provider, limits, now }: HeadroomReadings): number {
	const windows =
		limits
			.find((limit) => limit.provider === provider && limit.account === account)
			?.windows.filter((window) => isLiveWindow(window, now)) ?? [];
	return Math.min(100, ...windows.map((window) => windowHeadroom(window, now)));
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
): readonly T[] {
	const preferred = ordered.find((account) => account.name === preferredAccount);
	const normal =
		preferred === undefined ? ordered : [preferred, ...ordered.filter((account) => account !== preferred)];
	const nearLimit = new Set(
		limits
			.filter(
				(limit) =>
					limit.provider === provider &&
					limit.windows.some((window) => window.usedPercent >= 95 && isLiveWindow(window, now)),
			)
			.map((limit) => limit.account),
	);
	const withHeadroom = normal.filter((account) => !nearLimit.has(account.name));
	return withHeadroom.length > 0 ? withHeadroom : normal;
}
