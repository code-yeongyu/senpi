import {
	describeProviderFailureForUser,
	isRetryableErrorMessage,
	stripTurnRetrySuppressionPrefix,
} from "@earendil-works/pi-ai";
import { usageLimitScope } from "./retry-fallback/usage-limit.ts";

export type CompactionFailureKind = "compaction" | "auto-compaction" | "overflow-recovery";

export type CompactionFailureStep =
	| "provider"
	| "resend"
	| "larger-context"
	| "nothing-to-compact"
	| "compact-again"
	| "self-explained";

const LEAD: Record<CompactionFailureKind, string> = {
	compaction: "Compaction failed",
	"auto-compaction": "Auto-compaction failed",
	"overflow-recovery": "Context overflow recovery failed",
};

const STEP_TEXT: Record<Exclude<CompactionFailureStep, "provider" | "self-explained">, string> = {
	resend:
		"The conversation is larger than the model's context, and compacting it hit a temporary provider error. Send the message again; if it keeps failing, switch to a larger-context model.",
	"larger-context":
		"The conversation is larger than the model's context, and compacting it did not finish. Start a new session, or switch to a larger-context model.",
	"nothing-to-compact":
		"There is nothing older to summarize yet, so the context was left as it is. No action is needed.",
	"compact-again":
		"The summary of the earlier conversation could not be written. Compact again; if it keeps failing, start a new session or choose another model.",
};

/** The two refusals core raises before any summary request; both already say what happened. */
const NOTHING_TO_COMPACT = /^(?:Nothing to compact|Already compacted)\b/;
/** Rejection and cancellation texts that already name their own next step. */
const SELF_EXPLAINED = /^Compaction (?:rejected|cancelled)\b/;

function providerText(cause: string, model: string | undefined): string | undefined {
	return describeProviderFailureForUser(cause, { model, usageLimit: usageLimitScope(cause) });
}

/** Which step a failure names: a transient provider error during overflow recovery is worth resending (senpi#4329). */
export function compactionFailureStep(
	kind: CompactionFailureKind,
	cause: string,
	options: { readonly model?: string } = {},
): CompactionFailureStep {
	if (SELF_EXPLAINED.test(cause)) return "self-explained";
	if (providerText(cause, options.model) !== undefined) return "provider";
	if (kind === "overflow-recovery") return isRetryableErrorMessage(cause) ? "resend" : "larger-context";
	if (NOTHING_TO_COMPACT.test(cause)) return "nothing-to-compact";
	return "compact-again";
}

/**
 * The `compaction_end` failure text: the lead, the cause class with one next step that works on every
 * surface, then the raw cause as a diagnostic (senpi#4329). The raw text stays in the message so
 * consumers that read it (the TUI's transient-failure banner, overflow retry) see what they saw before.
 */
export function formatCompactionFailure(
	kind: CompactionFailureKind,
	error: string,
	options: { readonly model?: string } = {},
): string {
	const cause = stripTurnRetrySuppressionPrefix(error).trim();
	if (cause.length === 0) return `${LEAD[kind]}.`;
	const step = compactionFailureStep(kind, cause, options);
	if (step === "self-explained") return `${LEAD[kind]}: ${cause}`;
	const explanation = step === "provider" ? providerText(cause, options.model) : STEP_TEXT[step];
	return `${LEAD[kind]}: ${explanation} Cause: ${cause}`;
}
