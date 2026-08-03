import type { ClaudeSdkOauthSessionEntry, SessionBranchInfo } from "./session-registry.ts";
import { transitionToTainted } from "./session-registry-state.ts";

export type AnnotatableRegistry = {
	get(senpiSessionId: string): ClaudeSdkOauthSessionEntry | undefined;
	touch(entry: ClaudeSdkOauthSessionEntry): void;
};

export async function switchEntryModel(
	registry: AnnotatableRegistry,
	senpiSessionId: string,
	modelId: string,
): Promise<boolean> {
	const entry = registry.get(senpiSessionId);
	if (!entry?.query.setModel) return false;
	await entry.query.setModel(modelId);
	entry.modelId = modelId;
	registry.touch(entry);
	return true;
}

export function annotatePendingFork(registry: AnnotatableRegistry, senpiSessionId: string, reason: string): void {
	const entry = registry.get(senpiSessionId);
	if (!entry) return;
	entry.pendingForkReason = reason;
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
