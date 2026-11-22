import type { Api, Model } from "@earendil-works/pi-ai";
import type { RetryFallbackController } from "./controller.ts";
import { AccountUsageLimitError } from "./usage-limit.ts";

/** A queued continuation is automatic; it cannot use a fresh human prompt's hold bypass (#3131). */
export function queuedUsageHold(
	fallback: RetryFallbackController,
	model: Model<Api> | undefined,
): AccountUsageLimitError | undefined {
	if (!model) return undefined;
	const { provider } = model;
	if (fallback.isProviderSpent(provider)) {
		return new AccountUsageLimitError(
			provider,
			fallback.accountError(provider),
			fallback.accountResetAt(provider),
			fallback.widenedFamiliesOf(provider),
		);
	}
	const family = fallback.heldFamily(model);
	if (family) return new AccountUsageLimitError(provider, family.errorMessage, undefined, [family.family]);
}
