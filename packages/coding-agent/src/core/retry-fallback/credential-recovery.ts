import type { Api, Model } from "@earendil-works/pi-ai";
import { formatSelector } from "./chains.ts";
import type { ActiveFallbackState, RetryFallbackControllerDeps } from "./controller-types.ts";
import type { UnusableEntries } from "./unusable.ts";

type RecoveryDeps = Pick<RetryFallbackControllerDeps, "recoveryRevision" | "cooldowns" | "circuits" | "logger">;

/**
 * A billing pin assumes the original's account cannot recover by retrying it. A sign-in changes
 * that account, so when the original provider's login id moved since the episode began, the
 * billing pin and the original's cooldown, unusable mark and circuit are released and the
 * existing revert path tries it once. A still-dead original falls back again and pins with the
 * fresh id. Only billing-pinned episodes read the store. A token refresh keeps the id, and an
 * id that is gone ("") is no sign-in, so neither releases. Refusal pins hold: a new credential
 * does not change the context that was refused (senpi#4099).
 */
export async function releaseOnCredentialChange(
	state: ActiveFallbackState,
	original: Model<Api>,
	deps: RecoveryDeps,
	unusable: UnusableEntries,
): Promise<void> {
	if (!state.pinnedByBilling || state.recoveryRevision === undefined || !deps.recoveryRevision) return;
	const revision = await deps.recoveryRevision(original.provider);
	if (!revision || revision === state.recoveryRevision) return;
	state.recoveryRevision = revision;
	state.pinnedByBilling = false;
	state.pinned = state.pinnedByRefusal;
	const selector = formatSelector(original);
	deps.cooldowns.clearModel(selector);
	unusable.clear(original);
	deps.circuits?.close(selector);
	deps.logger.info("credential_recovery_released", {
		chainKey: state.chainKey,
		originalSelector: state.originalSelector,
		trigger: "sign-in",
	});
}
