import type { AccountLimits } from "../subscription-limits/limit-store.ts";

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
