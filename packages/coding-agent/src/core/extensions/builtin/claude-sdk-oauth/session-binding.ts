import type { ContinuityDecision } from "./session-continuity.ts";

export const BINDING_ENTRY_TYPE = "claude-sdk-oauth-binding";

export type BindingCheckpoint = {
	schemaVersion: 1;
	sdkSessionId: string;
	sentCount: number;
	sentPrefixHash: string;
	lastAssistantUuid: string | null;
	accountName: string;
	claudeConfigDir?: string;
	modelId: string;
	/**
	 * Config identity at the time the checkpoint was written. A live entry has its
	 * drift checked by `identityDrift`, which a restarted process cannot run because
	 * the entry is gone. Absent (pre-existing checkpoints) means unknown, and unknown
	 * never rehydrates.
	 */
	systemPromptHash?: string;
	toolsetHash?: string;
};

export type BindingInvalidation = { schemaVersion: 1; invalidated: true; reason: string };

type BranchEntry = { type: string; customType?: string; data?: unknown };

export type BindingVerificationInput = {
	binding: BindingCheckpoint;
	transcriptExists: boolean;
	transcriptHasBoundaryUuid: boolean;
	currentSentPrefixHash: string;
};

function isInvalidation(data: unknown): data is BindingInvalidation {
	return typeof data === "object" && data !== null && (data as BindingInvalidation).invalidated === true;
}

function isCheckpoint(data: unknown): data is BindingCheckpoint {
	return typeof data === "object" && data !== null && typeof (data as BindingCheckpoint).sdkSessionId === "string";
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

export function verifyBindingAgainstTranscript(input: BindingVerificationInput): ContinuityDecision {
	const { binding } = input;
	if (!input.transcriptExists) return { kind: "flatten", reason: "transcript_missing" };
	if (!binding.lastAssistantUuid || !input.transcriptHasBoundaryUuid) {
		return { kind: "flatten", reason: "branch_boundary_unavailable" };
	}
	if (input.currentSentPrefixHash === binding.sentPrefixHash) {
		return {
			kind: "reattach",
			sdkSessionId: binding.sdkSessionId,
			from: binding.sentCount,
			reason: "registry_miss",
		};
	}
	return {
		kind: "fork",
		sdkSessionId: binding.sdkSessionId,
		atUuid: binding.lastAssistantUuid,
		from: binding.sentCount,
		reason: "sent_stream_diverged",
	};
}

/**
 * Checkpoints read off the branch at `session_start`, held until the turn that can
 * verify them. The decision needs the current sent-hash prefix, which only exists
 * once the provider context is built, so the read and the check happen in different
 * places and this is the hand-off between them.
 */
const checkpoints = new Map<string, BindingCheckpoint>();

export function rememberCheckpoint(senpiSessionId: string, checkpoint: BindingCheckpoint): void {
	checkpoints.set(senpiSessionId, checkpoint);
}

export function getCheckpoint(senpiSessionId: string): BindingCheckpoint | undefined {
	return checkpoints.get(senpiSessionId);
}

export function forgetCheckpoint(senpiSessionId: string): void {
	checkpoints.delete(senpiSessionId);
}
