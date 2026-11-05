import { applyAccountOrder } from "@earendil-works/pi-ai/auth/pool/select";
import type { AccountLimits } from "../subscription-limits/limit-store.ts";

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
	return withHeadroom.length > 0 ? withHeadroom : normal;
}
