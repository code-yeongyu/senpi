import { AllAccountsBlockedError } from "./affinity.ts";
import { errorAccountContext } from "./account-context.ts";
import { classifySdkError } from "./errors.ts";
import type { ClaudeCodeRun } from "./executable.ts";
import { ClassifiedSdkError } from "./failover.ts";
import {
	allAccountsBlockedGuidance,
	claudeCodeVersionFloorGuidance,
	exhaustedPoolGuidance,
	sdkErrorGuidance,
	singleAccountUnavailableGuidance,
	switchAccountLine,
} from "./guidance.ts";
import { ClaudeSignInRequiredError } from "./sign-in-again.ts";

export function withAuthGuidance(error: unknown, message: string, ran?: ClaudeCodeRun, now = Date.now()): string {
	// The sign-in-again prompt is the remedy; the generic auth_error hint ("token was rejected... refresh") contradicts it.
	if (error instanceof ClaudeSignInRequiredError) return message;
	if (error instanceof AllAccountsBlockedError) {
		const guidance =
			error.unavailableAccount === undefined
				? allAccountsBlockedGuidance(error.soonestUnblockAt, error.blockReason, error.accounts)
				: singleAccountUnavailableGuidance(error.unavailableAccount, error.soonestUnblockAt, error.blockReason);
		// The model-limit sentence is how the fallback chain learns the limit binds this model only (senpi#5007).
		return error.limitedModel === undefined
			? guidance
			: `${modelLimitSentence(error, error.limitedModel, now)}\n${guidance}${retryAfterMarker(error, now)}`;
	}
	const kind = classifySdkError(error).kind;
	const account = errorAccountContext(error instanceof ClassifiedSdkError ? error.original : error);
	let guidance = sdkErrorGuidance(kind);
	if (account && (kind === "billing" || /\bout of extra usage\b/i.test(message))) {
		const selected = `Claude account '${account.accountLabel}' (source: ${account.accountSource}).`;
		const action =
			account.accountSource === "ambient"
				? "Switch the Claude Code login, or top up at claude.ai/settings/usage."
				: `${switchAccountLine(account.pinSource).trim()} Or top up this account at claude.ai/settings/usage.`;
		guidance = `${selected} ${action}`;
	}
	const versionGuidance = claudeCodeVersionFloorGuidance(message, ran);
	const pool = error instanceof ClassifiedSdkError ? error.poolState : undefined;
	const poolGuidance = pool && exhaustedPoolGuidance(pool.soonestUnblockAt, pool.accounts);
	const hints = [guidance, versionGuidance, poolGuidance].filter((hint): hint is string => hint !== undefined);
	return hints.length > 0 ? `${message}\n${hints.join("\n")}` : message;
}

/**
 * Names the limit, the model and its reset as relative prose, the form `usageLimitResetMs` (the
 * fallback hold) reads.
 */
function modelLimitSentence(error: AllAccountsBlockedError, model: string, now: number): string {
	const subject =
		error.unavailableAccount === undefined
			? "All Anthropic Subscription accounts have"
			: `Claude account '${error.unavailableAccount.name}' has`;
	const until = error.soonestUnblockAt;
	if (until === undefined || !Number.isFinite(until)) return `${subject} hit the usage limit for model ${model}.`;
	const waitMs = Math.max(0, until - now);
	const minutes = Math.ceil(waitMs / 60_000);
	return `${subject} hit the usage limit for model ${model}; it resets in ${Math.floor(minutes / 60)} hours ${minutes % 60} minutes, at ${new Date(until).toISOString()}.`;
}

/** The session's retry-delay reader only takes the marker at the very end of the text. */
function retryAfterMarker(error: AllAccountsBlockedError, now: number): string {
	const until = error.soonestUnblockAt;
	return until === undefined || !Number.isFinite(until) ? "" : ` (retry-after-ms: ${Math.max(0, until - now)})`;
}
