import type { AnthropicSubscriptionSessionEntry, SessionBranchInfo } from "./session-registry.ts";
import { transitionToTainted } from "./session-registry-state.ts";

export type AnnotatableRegistry = {
	get(senpiSessionId: string): AnthropicSubscriptionSessionEntry | undefined;
	touch(entry: AnthropicSubscriptionSessionEntry): void;
};

/**
 * Starts the live model switch without waiting for it: the claude CLI confirms the model with the API on every
 * `setModel` (80-280 ms, 15 s when unreachable), and `model_select` must not hold `set_model` for it (senpi#6411).
 * Switches chain on `entry.pendingModelSwitch` so they apply in order; the next turn admission awaits the chain.
 * A failed switch leaves `modelId` on the last confirmed model, so that admission sees the drift and reattaches
 * the same lineage on a fresh process with the selected model (`model_changed`), keeping the binding.
 */
export function switchEntryModel(
	registry: AnnotatableRegistry,
	senpiSessionId: string,
	modelId: string,
	sdkModel: string = modelId,
): boolean {
	const entry = registry.get(senpiSessionId);
	const setModel = entry?.query.setModel?.bind(entry.query);
	if (!entry || !setModel) return false;
	const apply = async (): Promise<void> => {
		if (registry.get(senpiSessionId) !== entry) return;
		await setModel(sdkModel);
		entry.modelId = modelId;
		registry.touch(entry);
	};
	const pending = (entry.pendingModelSwitch?.then(apply) ?? apply()).catch(() => undefined);
	entry.pendingModelSwitch = pending;
	void pending.then(() => {
		if (entry.pendingModelSwitch === pending) entry.pendingModelSwitch = undefined;
	});
	return true;
}

export function annotatePendingFork(
	registry: AnnotatableRegistry,
	senpiSessionId: string,
	reason: string,
	divergedPath?: string,
): void {
	const entry = registry.get(senpiSessionId);
	if (!entry) return;
	entry.pendingForkReason = reason;
	// A fork recorded without a path (compaction, tree change) must not inherit an earlier rewrite's path.
	entry.pendingForkDivergedPath = divergedPath ?? null;
	registry.touch(entry);
}

export function annotateTainted(registry: AnnotatableRegistry, senpiSessionId: string, reason: string): void {
	const entry = registry.get(senpiSessionId);
	if (!entry) return;
	entry.taintedReason = reason;
	if (entry.state !== "TAINTED") transitionToTainted(entry);
	registry.touch(entry);
}

export function annotateBranchInfo(
	registry: AnnotatableRegistry,
	senpiSessionId: string,
	info: SessionBranchInfo,
): void {
	const entry = registry.get(senpiSessionId);
	if (!entry) return;
	entry.branchInfo = { ...info };
	registry.touch(entry);
}
