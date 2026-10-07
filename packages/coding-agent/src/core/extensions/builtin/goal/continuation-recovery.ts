export const CONTINUATION_CAP_BLOCKED_REASON = "continuation cap reached";
export const REPETITION_BLOCKED_REASON = "repeated assistant output";
export const LENGTH_EXHAUSTED_BLOCKED_REASON = "output truncation repeated";
export const UNATTENDED_CONTINUATION_BLOCKED_REASON = "unattended continuation limit reached";
export const PROVIDER_ERROR_BLOCKED_REASON = "provider error ended the turn (retries exhausted)";
export const CONTEXT_OVERFLOW_BLOCKED_REASON = "context overflow ended the turn (compaction did not recover)";
export const PROVIDER_AUTH_BLOCKED_REASON_PREFIX = "provider rejected the request: ";

// Mechanical blocks are stops the runtime imposed on itself, not decisions the
// user or the model made. A terminal provider error belongs here: the provider
// failing is infrastructure, and the user's next message is exactly the retry
// signal, so the goal resumes instead of stranding behind a block that only
// `/goal resume` could clear.
const MECHANICAL_CONTINUATION_BLOCKS: readonly string[] = [
	CONTINUATION_CAP_BLOCKED_REASON,
	REPETITION_BLOCKED_REASON,
	LENGTH_EXHAUSTED_BLOCKED_REASON,
	UNATTENDED_CONTINUATION_BLOCKED_REASON,
	PROVIDER_ERROR_BLOCKED_REASON,
	CONTEXT_OVERFLOW_BLOCKED_REASON,
];

const RESUME_GUIDANCE = "Send any message to resume.";

export function isMechanicalContinuationBlock(blockedReason: string | undefined): boolean {
	if (blockedReason === undefined) return false;
	// A rejected credential is fixed outside the session (/login, a new key), so
	// the user's next message is the signal that the fix is in.
	if (blockedReason.startsWith(PROVIDER_AUTH_BLOCKED_REASON_PREFIX)) return true;
	return MECHANICAL_CONTINUATION_BLOCKS.includes(blockedReason);
}

export interface ProviderAuthBlock {
	readonly httpStatus: 401 | 403;
	readonly provider: string;
	readonly model: string;
}

export function providerAuthBlockedReason(block: ProviderAuthBlock): string {
	const verdict = block.httpStatus === 401 ? "authentication failed" : "access denied";
	return `${PROVIDER_AUTH_BLOCKED_REASON_PREFIX}HTTP ${block.httpStatus} ${verdict} for ${block.provider}/${block.model}`;
}

function planName(provider: string): string {
	return provider === "github-copilot" ? "your Copilot plan" : "your account or plan";
}

export function providerAuthRecoveryHint(block: ProviderAuthBlock): string {
	const fix =
		block.httpStatus === 401
			? `Run /login ${block.provider} to sign in again, or check the API key or token for ${block.provider}`
			: `Run /login ${block.provider} to refresh the account, or check that ${block.model} is enabled for ${planName(block.provider)}`;
	return [
		`Goal continuation blocked: ${providerAuthBlockedReason(block)}.`,
		"Retrying would get the same rejection, so the goal stopped instead of retrying.",
		`${fix}, and check any proxy or gateway in front of it. Then send any message to resume.`,
	].join(" ");
}

export function continuationCapRecoveryHint(blockedReason: string): string {
	if (!isMechanicalContinuationBlock(blockedReason)) return `Goal continuation blocked: ${blockedReason}`;
	return `Goal continuation blocked: ${blockedReason}. ${RESUME_GUIDANCE}`;
}
