import { COLLAPSE_RULE_CONTENT } from "./prompts.ts";
import {
	buildErrorShellReplacement,
	buildNudgeMessage,
	buildTruncateReplacement,
	type ErrorShellReplacement,
	type TruncatableAssistantMessage,
	type TtsrNudgeMessage,
} from "./remediation.ts";
import type { DetectionResolution } from "./types.ts";

export interface StreamRemediationInput {
	readonly resolution: DetectionResolution;
	readonly streamKind: "text" | "thinking" | "tool";
}

export interface StreamRemediationOutcome {
	readonly replacement: ErrorShellReplacement | TruncatableAssistantMessage;
	readonly nudge: TtsrNudgeMessage | null;
	readonly owner: string;
	readonly observedRules: readonly string[];
	readonly retryMode: "nudge" | "provider-error";
}

export function buildStreamRemediation(pending: StreamRemediationInput, message: unknown): StreamRemediationOutcome {
	if (pending.resolution.remediation.corruptionScope === "generation") {
		return {
			replacement: buildErrorShellReplacement(),
			nudge: null,
			owner: pending.resolution.owner,
			observedRules: pending.resolution.observedRules,
			retryMode: "provider-error",
		};
	}
	const replaced = buildTruncateReplacement(
		message as TruncatableAssistantMessage,
		pending.resolution.match.garbageStartOffset,
		pending.streamKind,
	);
	return {
		replacement: replaced,
		nudge: buildNudgeMessage(pending.resolution.owner, COLLAPSE_RULE_CONTENT),
		owner: pending.resolution.owner,
		observedRules: pending.resolution.observedRules,
		retryMode: "nudge",
	};
}
