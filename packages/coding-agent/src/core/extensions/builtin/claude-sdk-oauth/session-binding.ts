import type { ContinuityBinding } from "./session-reattach.ts";
import { sentHashPrefixDigest } from "./session-sync.ts";

export const BINDING_ENTRY_TYPE = "claude-sdk-oauth-binding";

export type BindingCheckpoint = {
	schemaVersion: 1;
	sdkSessionId: string;
	sentCount: number;
	sentPrefixHash: string;
	lastAssistantUuid: string | null;
	accountName: string;
	modelId: string;
	systemPromptHash: string;
	toolsetHash: string;
};

export type BindingInvalidation = { schemaVersion: 1; invalidated: true; reason: string };

type BranchEntry = {
	type: string;
	customType?: string;
	data?: unknown;
	message?: { role?: unknown };
};

const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_CHECKPOINT_TEXT_LENGTH = 256;

function isBoundedText(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_CHECKPOINT_TEXT_LENGTH;
}

function isInvalidation(data: unknown): data is BindingInvalidation {
	if (typeof data !== "object" || data === null) return false;
	const invalidation = data as Partial<BindingInvalidation>;
	return invalidation.schemaVersion === 1 && invalidation.invalidated === true && isBoundedText(invalidation.reason);
}

function isCheckpoint(data: unknown): data is BindingCheckpoint {
	if (typeof data !== "object" || data === null) return false;
	const checkpoint = data as Partial<BindingCheckpoint>;
	return (
		checkpoint.schemaVersion === 1 &&
		isBoundedText(checkpoint.sdkSessionId) &&
		Number.isSafeInteger(checkpoint.sentCount) &&
		(checkpoint.sentCount ?? -1) >= 0 &&
		typeof checkpoint.sentPrefixHash === "string" &&
		SHA256_HEX.test(checkpoint.sentPrefixHash) &&
		(checkpoint.lastAssistantUuid === null || isBoundedText(checkpoint.lastAssistantUuid)) &&
		isBoundedText(checkpoint.accountName) &&
		isBoundedText(checkpoint.modelId) &&
		typeof checkpoint.systemPromptHash === "string" &&
		SHA256_HEX.test(checkpoint.systemPromptHash) &&
		typeof checkpoint.toolsetHash === "string" &&
		SHA256_HEX.test(checkpoint.toolsetHash)
	);
}

export function latestBindingOnBranch(branch: readonly BranchEntry[]): BindingCheckpoint | undefined {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== BINDING_ENTRY_TYPE) continue;
		if (isInvalidation(entry.data)) return undefined;
		if (isCheckpoint(entry.data)) {
			const committedAssistant = branch[index + 1];
			if (committedAssistant?.type !== "message" || committedAssistant.message?.role !== "assistant") {
				return undefined;
			}
			return entry.data;
		}
		return undefined;
	}
	return undefined;
}

export function checkpointFromBinding(binding: ContinuityBinding): BindingCheckpoint {
	return {
		schemaVersion: 1,
		sdkSessionId: binding.sdkSessionId,
		sentCount: binding.sentCount,
		sentPrefixHash: sentHashPrefixDigest(binding.sentHashes, binding.sentCount),
		lastAssistantUuid: binding.lastAssistantUuid,
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
		sentHashes: [],
		sentPrefixHash: checkpoint.sentPrefixHash,
		lastAssistantUuid: checkpoint.lastAssistantUuid,
		assistantUuidByIndex:
			checkpoint.lastAssistantUuid === null ? [] : [[checkpoint.sentCount, checkpoint.lastAssistantUuid]],
		accountName: checkpoint.accountName,
		modelId: checkpoint.modelId,
		systemPromptHash: checkpoint.systemPromptHash,
		toolsetHash: checkpoint.toolsetHash,
	};
}
