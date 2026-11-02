import type { ActiveFallbackState, FallbackReason } from "./controller-types.ts";
import type { UsageLimitScope } from "./usage-limit.ts";

type PinProvenance = Pick<ActiveFallbackState, "originalSelector" | "pinnedByRefusal" | "pinnedByBilling" | "pinned">;

/**
 * Pin provenance after one fallback switch away from `from`. A refusal pins (the same
 * context refuses again). Billing pins only when the ORIGINAL cannot recover: the
 * failure hit that model, or the whole account the original lives on. Billing on a
 * fallback target from another account says nothing about the original, which failed
 * for a different reason, so it must not hold the session there (senpi#2376).
 */
export function pinAfterSwitch(
	prior: PinProvenance | undefined,
	switch_: { from: string; fromProvider: string; reason: FallbackReason; limit: UsageLimitScope | undefined },
): PinProvenance {
	const originalSelector = prior?.originalSelector ?? switch_.from;
	const billingHitsOriginal =
		switch_.reason === "billing" &&
		(switch_.from === originalSelector ||
			(switch_.limit === "account" && originalSelector.startsWith(`${switch_.fromProvider}/`)));
	const pinnedByRefusal = prior?.pinnedByRefusal === true || switch_.reason === "refusal";
	const pinnedByBilling = prior?.pinnedByBilling === true || billingHitsOriginal;
	return { originalSelector, pinnedByRefusal, pinnedByBilling, pinned: pinnedByRefusal || pinnedByBilling };
}
