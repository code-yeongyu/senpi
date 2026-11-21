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
 * All strategies share the user's stored order; cache-affine and most-headroom use HRW as their base.
 * most-headroom then ranks by remaining usage, keeping that base order between equal accounts.
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
			// Array sort is stable, so accounts with equal headroom keep the base order.
			return base.sort((left, right) => (remaining.get(right.name) ?? 0) - (remaining.get(left.name) ?? 0));
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
 * Percent left in the account's tightest live window. An account with no reported usage counts as
 * unused, so a new or never-polled account gets tried and reports its usage.
 */
function remainingPercent(account: string, { provider, limits, now }: HeadroomReadings): number {
	const windows =
		limits
			.find((limit) => limit.provider === provider && limit.account === account)
			?.windows.filter((window) => isLiveWindow(window, now)) ?? [];
	return 100 - Math.max(0, ...windows.map((window) => window.usedPercent));
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
