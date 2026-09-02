import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { StoredBinding } from "./session-binding-store.ts";
import { assistantContentHash } from "./session-commit-boundary.ts";
import type { ContinuityBinding } from "./session-reattach.ts";
import { sentHashPrefixDigest } from "./session-sync.ts";

export const BINDING_ENTRY_TYPE = "claude-sdk-oauth-binding";
export const BINDING_MARKER = { schemaVersion: 2, marker: true } as const;

export type BindingInvalidation = {
	readonly schemaVersion: 1;
	readonly invalidated: true;
	readonly reason: string;
};

type BranchEntry = {
	readonly id?: string;
	readonly type: string;
	readonly customType?: string;
	readonly data?: unknown;
	readonly message?: unknown;
};

export type StoredBindingAnchor = {
	readonly sessionPath: string;
	readonly sessionId: string;
	readonly markerEntryId: string;
	readonly assistantContentHash: string;
};

export type BindingEntryState = {
	readonly sdkSessionId: string;
	readonly accountName: string;
	readonly modelId: string;
	readonly systemPromptHash: string;
	readonly toolsetHash: string;
	readonly assistantUuidByIndex: ReadonlyMap<number, string>;
};

/**
 * The record is derived from the registry entry plus the hashes the branch
 * actually carries, never from the process binding map: that map holds the
 * previous turn's state while `message_end` runs (and only a prefix digest right
 * after a restart), so reading it would anchor this turn's marker to a stale or
 * absent sent-stream.
 */
export function storedBindingFromEntry(
	entry: BindingEntryState,
	hashes: readonly string[],
	anchor: StoredBindingAnchor,
): StoredBinding {
	return {
		schemaVersion: 1,
		sessionPath: anchor.sessionPath,
		sessionId: anchor.sessionId,
		markerEntryId: anchor.markerEntryId,
		sdkSessionId: entry.sdkSessionId,
		sentCount: hashes.length,
		sentPrefixHash: sentHashPrefixDigest(hashes),
		assistantContentHash: anchor.assistantContentHash,
		lastAssistantUuid: entry.assistantUuidByIndex.get(hashes.length) ?? null,
		accountName: entry.accountName,
		modelId: entry.modelId,
		systemPromptHash: entry.systemPromptHash,
		toolsetHash: entry.toolsetHash,
	};
}

/** Persist a completed turn whose resident registry entry closed before `message_end`. */
export function storedBindingFromBinding(
	binding: ContinuityBinding,
	hashes: readonly string[],
	anchor: StoredBindingAnchor,
): StoredBinding | undefined {
	if (binding.sentCount !== hashes.length) return undefined;
	return {
		schemaVersion: 1,
		sessionPath: anchor.sessionPath,
		sessionId: anchor.sessionId,
		markerEntryId: anchor.markerEntryId,
		sdkSessionId: binding.sdkSessionId,
		sentCount: hashes.length,
		sentPrefixHash: sentHashPrefixDigest(hashes),
		assistantContentHash: anchor.assistantContentHash,
		lastAssistantUuid: binding.lastAssistantUuid,
		accountName: binding.accountName,
		modelId: binding.modelId,
		systemPromptHash: binding.systemPromptHash,
		toolsetHash: binding.toolsetHash,
	};
}

export function bindingFromStoredBranch(
	branch: readonly BranchEntry[],
	stored: StoredBinding,
): ContinuityBinding | undefined {
	const markerIndex = newestBindingEntryIndex(branch);
	if (markerIndex < 0) return undefined;
	const marker = branch[markerIndex];
	if (
		marker?.id !== stored.markerEntryId ||
		!isBindingMarker(marker.data) ||
		!branch.slice(markerIndex + 2).every(isSafeBindingSuffix)
	) {
		return undefined;
	}
	const committedAssistant = branch[markerIndex + 1]?.message;
	if (!isAssistantMessage(committedAssistant)) return undefined;
	if (assistantContentHash(committedAssistant) !== stored.assistantContentHash) return undefined;
	return bindingFromStored(stored);
}

/**
 * Display-only metadata the co-resident builtins append after the committed
 * assistant (stop-hook state/diagnostics/output, rule activations, rule scans).
 * None participates in the sent stream, so none can shift the prefix digest.
 */
const SAFE_BINDING_SUFFIX_TYPES: ReadonlySet<string> = new Set([
	"senpi.hooks.stop-state",
	"senpi.hooks.stop-diagnostics",
	"senpi.hooks.stop-output",
	"pi-rules.scan",
	"rule-activation",
	"goal-cache-warmup",
	"senpi-memory.session-binding",
	"omo-memory:accepted-turns",
]);

function isSafeBindingSuffix(entry: BranchEntry): boolean {
	if (entry.type === "label" || entry.type === "custom_message") return true;
	if (entry.type === "message") {
		return isSentMessage(entry.message);
	}
	return entry.type === "custom" && entry.customType !== undefined && SAFE_BINDING_SUFFIX_TYPES.has(entry.customType);
}

function isSentMessage(value: unknown): boolean {
	if (typeof value !== "object" || value === null || !("role" in value)) return false;
	return value.role === "user" || value.role === "toolResult";
}

function newestBindingEntryIndex(branch: readonly BranchEntry[]): number {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type === "custom" && entry.customType === BINDING_ENTRY_TYPE) return index;
	}
	return -1;
}

function isBindingMarker(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	return "schemaVersion" in value && value.schemaVersion === 2 && "marker" in value && value.marker === true;
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
	if (typeof value !== "object" || value === null) return false;
	return (
		"role" in value &&
		value.role === "assistant" &&
		"api" in value &&
		typeof value.api === "string" &&
		"provider" in value &&
		typeof value.provider === "string" &&
		"model" in value &&
		typeof value.model === "string" &&
		"content" in value &&
		Array.isArray(value.content)
	);
}

function bindingFromStored(stored: StoredBinding): ContinuityBinding {
	return {
		senpiSessionId: stored.sessionId,
		sdkSessionId: stored.sdkSessionId,
		sentCount: stored.sentCount,
		sentHashes: [],
		sentPrefixHash: stored.sentPrefixHash,
		lastAssistantUuid: stored.lastAssistantUuid,
		assistantUuidByIndex: stored.lastAssistantUuid === null ? [] : [[stored.sentCount, stored.lastAssistantUuid]],
		accountName: stored.accountName,
		modelId: stored.modelId,
		systemPromptHash: stored.systemPromptHash,
		toolsetHash: stored.toolsetHash,
	};
}
