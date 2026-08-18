import type { ContinuityBinding } from "./session-reattach.ts";

export const BINDING_ENTRY_TYPE = "claude-sdk-oauth-binding";

export type BindingCheckpoint = {
	schemaVersion: 1;
	sdkSessionId: string;
	sentCount: number;
	sentHashes: string[];
	lastAssistantUuid: string | null;
	assistantUuidByIndex: [number, string][];
	accountName: string;
	modelId: string;
	systemPromptHash: string;
	toolsetHash: string;
};

export type BindingInvalidation = { schemaVersion: 1; invalidated: true; reason: string };

type BranchEntry = { type: string; customType?: string; data?: unknown };

function isInvalidation(data: unknown): data is BindingInvalidation {
	return typeof data === "object" && data !== null && (data as BindingInvalidation).invalidated === true;
}

function isCheckpoint(data: unknown): data is BindingCheckpoint {
	if (typeof data !== "object" || data === null) return false;
	const checkpoint = data as Partial<BindingCheckpoint>;
	return (
		checkpoint.schemaVersion === 1 &&
		typeof checkpoint.sdkSessionId === "string" &&
		Number.isInteger(checkpoint.sentCount) &&
		(checkpoint.sentCount ?? -1) >= 0 &&
		Array.isArray(checkpoint.sentHashes) &&
		checkpoint.sentHashes.every((hash) => typeof hash === "string") &&
		(checkpoint.lastAssistantUuid === null || typeof checkpoint.lastAssistantUuid === "string") &&
		Array.isArray(checkpoint.assistantUuidByIndex) &&
		checkpoint.assistantUuidByIndex.every(
			(boundary) =>
				Array.isArray(boundary) &&
				boundary.length === 2 &&
				Number.isInteger(boundary[0]) &&
				typeof boundary[1] === "string",
		) &&
		typeof checkpoint.accountName === "string" &&
		typeof checkpoint.modelId === "string" &&
		typeof checkpoint.systemPromptHash === "string" &&
		typeof checkpoint.toolsetHash === "string"
	);
}

export function latestBindingOnBranch(branch: readonly BranchEntry[]): BindingCheckpoint | undefined {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== BINDING_ENTRY_TYPE) continue;
		if (isInvalidation(entry.data)) return undefined;
		if (isCheckpoint(entry.data)) return entry.data;
	}
	return undefined;
}

export function checkpointFromBinding(binding: ContinuityBinding): BindingCheckpoint {
	return {
		schemaVersion: 1,
		sdkSessionId: binding.sdkSessionId,
		sentCount: binding.sentCount,
		sentHashes: [...binding.sentHashes],
		lastAssistantUuid: binding.lastAssistantUuid,
		assistantUuidByIndex: binding.assistantUuidByIndex?.map(([index, uuid]) => [index, uuid]) ?? [],
		accountName: binding.accountName,
		modelId: binding.modelId,
		systemPromptHash: binding.systemPromptHash,
		toolsetHash: binding.toolsetHash,
	};
}

export function bindingFromCheckpoint(senpiSessionId: string, checkpoint: BindingCheckpoint): ContinuityBinding {
	return {
		senpiSessionId,
		sdkSessionId: checkpoint.sdkSessionId,
		sentCount: checkpoint.sentCount,
		sentHashes: [...checkpoint.sentHashes],
		lastAssistantUuid: checkpoint.lastAssistantUuid,
		assistantUuidByIndex: checkpoint.assistantUuidByIndex.map(([index, uuid]) => [index, uuid]),
		accountName: checkpoint.accountName,
		modelId: checkpoint.modelId,
		systemPromptHash: checkpoint.systemPromptHash,
		toolsetHash: checkpoint.toolsetHash,
	};
}
