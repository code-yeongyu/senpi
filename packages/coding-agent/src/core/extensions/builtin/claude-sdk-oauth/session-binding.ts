import type { ContinuityDecision } from "./session-continuity.ts";

export const BINDING_ENTRY_TYPE = "claude-sdk-oauth-binding";

export type BindingCheckpoint = {
	schemaVersion: 1;
	sdkSessionId: string;
	sentCount: number;
	sentPrefixHash: string;
	lastAssistantUuid: string | null;
	accountName: string;
	claudeConfigDir: string;
	modelId: string;
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
