import type { ContinuityReason } from "./session-observability.ts";

export type ContinuityEntrySnapshot = {
	sdkSessionId: string;
	accountName: string;
	modelId: string;
	systemPromptHash: string;
	toolsetHash: string;
	sentCount: number;
	sentHashes: readonly string[];
	lastAssistantUuid: string | null;
	assistantUuidByIndex: ReadonlyMap<number, string>;
	pendingForkReason: string | null;
	taintedReason?: string | null;
};

export type ContinuityBindingSnapshot = {
	sdkSessionId: string;
	sentCount: number;
	sentHashes: readonly string[];
	lastAssistantUuid: string | null;
	accountName: string;
	modelId: string;
	systemPromptHash: string;
	toolsetHash: string;
};

export type ContinuityDecisionInput = {
	entry: ContinuityEntrySnapshot | undefined;
	binding: ContinuityBindingSnapshot | undefined;
	currentHashes: readonly string[];
	accountName: string;
	modelId: string;
	fingerprint: { systemPromptHash: string; toolsetHash: string };
	transcriptAvailable: boolean;
	idleExpired?: boolean;
};

export type ContinuityDecision =
	| { kind: "bootstrap" }
	| { kind: "delta"; from: number }
	| { kind: "reattach"; sdkSessionId: string; from: number; reason: ContinuityReason }
	| { kind: "fork"; sdkSessionId: string; atUuid: string; from: number; reason: ContinuityReason }
	| { kind: "flatten"; reason: ContinuityReason };

const PENDING_FORK_REASONS: Readonly<Record<string, ContinuityReason>> = {
	assistant_rewritten: "assistant_rewritten",
	compaction: "tainted_compaction",
	fork: "tainted_fork",
	abort: "tainted_abort",
};

function commonPrefixLength(left: readonly string[], right: readonly string[]): number {
	const limit = Math.min(left.length, right.length);
	let index = 0;
	while (index < limit && left[index] === right[index]) index += 1;
	return index;
}

/**
 * The fork point is the last assistant boundary STRICTLY BEFORE the divergence:
 * forking at the diverged turn itself would carry the stale assistant into the new
 * branch and leave nothing to re-send.
 */
function boundaryBefore(entry: ContinuityEntrySnapshot, count: number): { index: number; uuid: string } | undefined {
	for (let candidate = count - 1; candidate >= 1; candidate -= 1) {
		const uuid = entry.assistantUuidByIndex.get(candidate);
		if (uuid) return { index: candidate, uuid };
	}
	return undefined;
}

function forkOrFlatten(
	entry: ContinuityEntrySnapshot,
	divergesAt: number,
	reason: ContinuityReason,
): ContinuityDecision {
	const boundary = boundaryBefore(entry, divergesAt);
	if (!boundary) return { kind: "flatten", reason };
	return {
		kind: "fork",
		sdkSessionId: entry.sdkSessionId,
		atUuid: boundary.uuid,
		from: boundary.index,
		reason,
	};
}

function identityDrift(input: ContinuityDecisionInput, entry: ContinuityEntrySnapshot): ContinuityReason | null {
	if (entry.accountName !== input.accountName) return "account_changed";
	if (entry.modelId !== input.modelId) return "model_changed";
	if (entry.systemPromptHash !== input.fingerprint.systemPromptHash) return "options_changed";
	if (entry.toolsetHash !== input.fingerprint.toolsetHash) return "options_changed";
	return null;
}

function decideFromBinding(input: ContinuityDecisionInput, binding: ContinuityBindingSnapshot): ContinuityDecision {
	if (!input.transcriptAvailable) return { kind: "flatten", reason: "transcript_missing" };
	const shared = commonPrefixLength(binding.sentHashes, input.currentHashes);
	if (shared === binding.sentCount) {
		return { kind: "reattach", sdkSessionId: binding.sdkSessionId, from: binding.sentCount, reason: "registry_miss" };
	}
	if (!binding.lastAssistantUuid) return { kind: "flatten", reason: "registry_miss" };
	return {
		kind: "fork",
		sdkSessionId: binding.sdkSessionId,
		atUuid: binding.lastAssistantUuid,
		from: shared,
		reason: shared < binding.sentCount ? "history_rolled_back" : "sent_stream_diverged",
	};
}

export type FailoverLane = "oauth-slots" | "ambient" | "config-dir";

export type FailoverContinuityInput = {
	authLane: FailoverLane;
	crossAccountResumeSupported: boolean;
	entry: { sdkSessionId: string; sentCount: number; lastAssistantUuid: string | null };
};

/**
 * The config-dir lane keeps each account's credentials inside its own
 * CLAUDE_CONFIG_DIR, and no official SDK API moves a transcript across roots, so
 * its failover is the one declared residual that must still flatten.
 */
export function decideFailoverContinuity(input: FailoverContinuityInput): ContinuityDecision {
	const { entry } = input;
	if (input.authLane === "config-dir") return { kind: "flatten", reason: "cross_root_unsupported" };
	if (input.crossAccountResumeSupported) {
		return {
			kind: "reattach",
			sdkSessionId: entry.sdkSessionId,
			from: entry.sentCount,
			reason: "account_changed",
		};
	}
	if (!entry.lastAssistantUuid) return { kind: "flatten", reason: "branch_boundary_unavailable" };
	return {
		kind: "fork",
		sdkSessionId: entry.sdkSessionId,
		atUuid: entry.lastAssistantUuid,
		from: entry.sentCount,
		reason: "account_changed",
	};
}

/**
 * Resume-first: a live session is never abandoned for a flattened re-send. Only a
 * missing transcript or an unrecoverable boundary reaches `flatten`; every other
 * divergence resolves to `fork` (same lineage, new branch) or `reattach` (same
 * session, new query).
 */
export function decideNativeContinuity(input: ContinuityDecisionInput): ContinuityDecision {
	const { entry, binding } = input;
	if (!entry) {
		if (!binding) return { kind: "bootstrap" };
		return decideFromBinding(input, binding);
	}

	const divergence = entry.pendingForkReason ?? entry.taintedReason;
	if (divergence) {
		return forkOrFlatten(entry, entry.sentCount, PENDING_FORK_REASONS[divergence] ?? "other");
	}

	const shared = commonPrefixLength(entry.sentHashes, input.currentHashes);
	if (shared < entry.sentCount) {
		const rolledBack = input.currentHashes.length < entry.sentCount && shared === input.currentHashes.length;
		return rolledBack
			? forkOrFlatten(entry, input.currentHashes.length, "history_rolled_back")
			: forkOrFlatten(entry, shared + 1, "sent_stream_diverged");
	}

	if (input.idleExpired) {
		return { kind: "reattach", sdkSessionId: entry.sdkSessionId, from: entry.sentCount, reason: "idle_ttl" };
	}

	const drift = identityDrift(input, entry);
	if (drift) {
		return { kind: "reattach", sdkSessionId: entry.sdkSessionId, from: entry.sentCount, reason: drift };
	}

	return { kind: "delta", from: entry.sentCount };
}
