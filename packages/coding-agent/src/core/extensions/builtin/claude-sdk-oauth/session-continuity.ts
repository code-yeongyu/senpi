import type { ContinuityReason } from "./session-observability.ts";
import { sentHashPrefixDigest } from "./session-sync.ts";

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
	sentPrefixHash?: string;
	lastAssistantUuid: string | null;
	accountName: string;
	modelId: string;
	systemPromptHash: string;
	toolsetHash: string;
	/** Sent-stream digest of a turn that was pushed but never answered (retry checkpoint). */
	unansweredTurnDigest?: string;
	/** False until the SDK acknowledged the id; a resume/fork of an unconfirmed id is never attempted. */
	sdkSessionIdConfirmed?: boolean;
};

export type ContinuityDecisionInput = {
	entry: ContinuityEntrySnapshot | undefined;
	binding: ContinuityBindingSnapshot | undefined;
	currentHashes: readonly string[];
	accountName: string;
	modelId: string;
	fingerprint: { systemPromptHash: string; toolsetHash: string };
	transcriptAvailable: boolean;
	/** false only on the config-dir lane, whose per-account credential roots cannot share a transcript root, so cross-account resume is impossible there. */
	crossAccountResumeSupported: boolean;
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

function identityDrift(
	input: ContinuityDecisionInput,
	entry: Pick<ContinuityEntrySnapshot, "accountName" | "modelId" | "systemPromptHash" | "toolsetHash">,
): ContinuityReason | null {
	if (entry.accountName !== input.accountName) return "account_changed";
	if (entry.modelId !== input.modelId) return "model_changed";
	if (entry.systemPromptHash !== input.fingerprint.systemPromptHash) return "system_prompt_changed";
	if (entry.toolsetHash !== input.fingerprint.toolsetHash) return "toolset_changed";
	return null;
}

/**
 * Same-turn retry after a stream-start timeout: the abandoned attempt already
 * appended its user message to the lineage, so re-attaching would append it a
 * SECOND time and re-bill the whole conversation. Forking at the pre-turn
 * assistant boundary rewinds past the un-answered message, so the retry's
 * request byte-layout matches the failed attempt's (prefix cache read).
 * Requires the FULL current turn to hash-match the checkpoint, so a different
 * turn falls through to the ordinary branches below.
 */
function retryCheckpointDecision(
	input: ContinuityDecisionInput,
	binding: ContinuityBindingSnapshot,
): ContinuityDecision | undefined {
	if (binding.unansweredTurnDigest === undefined) return undefined;
	if (sentHashPrefixDigest(input.currentHashes, input.currentHashes.length) !== binding.unansweredTurnDigest) {
		return undefined;
	}
	if (input.currentHashes.length < binding.sentCount) return undefined;
	const prefixMatches =
		binding.sentPrefixHash !== undefined
			? sentHashPrefixDigest(input.currentHashes, binding.sentCount) === binding.sentPrefixHash
			: commonPrefixLength(binding.sentHashes, input.currentHashes) === binding.sentCount;
	if (!prefixMatches) return undefined;
	if (!binding.lastAssistantUuid) return { kind: "flatten", reason: "timeout_retry" };
	return {
		kind: "fork",
		sdkSessionId: binding.sdkSessionId,
		atUuid: binding.lastAssistantUuid,
		from: binding.sentCount,
		reason: "timeout_retry",
	};
}

/**
 * A binding whose SDK id was minted locally and never acknowledged (no init, no
 * replay echo before the attempt failed) must not be resumed: Claude Code
 * answers "No conversation found with session ID" and every retry would mint
 * another dead id (oh-my-openagent#7562). Cold-seed instead.
 */
function withoutUnconfirmedResume(
	decision: ContinuityDecision,
	binding: ContinuityBindingSnapshot,
): ContinuityDecision {
	if (binding.sdkSessionIdConfirmed !== false) return decision;
	if (decision.kind === "reattach" || decision.kind === "fork") {
		return { kind: "flatten", reason: "session_unconfirmed" };
	}
	return decision;
}

function decideFromBinding(input: ContinuityDecisionInput, binding: ContinuityBindingSnapshot): ContinuityDecision {
	if (!input.transcriptAvailable) return { kind: "flatten", reason: "transcript_missing" };
	const drift = identityDrift(input, binding);
	// Model identity drift fails closed: the persisted identity no longer matches the turn.
	// Account drift flattens only on the config-dir lane, whose per-account roots cannot
	// share a transcript; on shared-root lanes it falls through like prompt/toolset drift
	// (senpi#1432), so the retry checkpoint forks a same-turn failover at the pre-turn
	// boundary and a matching prefix reattaches with reason account_changed.
	if (drift === "model_changed") return { kind: "flatten", reason: drift };
	if (drift === "account_changed" && !input.crossAccountResumeSupported)
		return { kind: "flatten", reason: "cross_root_unsupported" };
	// Prompt/toolset drift instead reattaches like the live path
	// (oh-my-openagent#7884) - a restart has no live query, so the resume builds a
	// fresh query carrying the CURRENT options and hooks, and flattening would
	// re-send the whole conversation for drift the SDK applies per-query anyway.
	const retry = retryCheckpointDecision(input, binding);
	if (retry) return retry;
	if (binding.sentPrefixHash !== undefined) {
		const prefixMatches =
			input.currentHashes.length >= binding.sentCount &&
			sentHashPrefixDigest(input.currentHashes, binding.sentCount) === binding.sentPrefixHash;
		if (prefixMatches) {
			return {
				kind: "reattach",
				sdkSessionId: binding.sdkSessionId,
				from: binding.sentCount,
				reason: drift ?? "registry_miss",
			};
		}
		return {
			kind: "flatten",
			reason: input.currentHashes.length < binding.sentCount ? "history_rolled_back" : "sent_stream_diverged",
		};
	}
	const shared = commonPrefixLength(binding.sentHashes, input.currentHashes);
	if (shared === binding.sentCount) {
		return {
			kind: "reattach",
			sdkSessionId: binding.sdkSessionId,
			from: binding.sentCount,
			reason: drift ?? "registry_miss",
		};
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

/**
 * Resume-first: a live session is never abandoned for a flattened re-send. Only a
 * missing transcript, an unrecoverable boundary, a model identity drift, or account
 * drift on the config-dir lane on a persisted binding reaches `flatten`; every other
 * divergence resolves to `fork` (same lineage, new branch) or `reattach` (same
 * session, new query).
 */
export function decideNativeContinuity(input: ContinuityDecisionInput): ContinuityDecision {
	const { entry, binding } = input;
	if (!entry) {
		if (!binding) return { kind: "bootstrap" };
		return withoutUnconfirmedResume(decideFromBinding(input, binding), binding);
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
