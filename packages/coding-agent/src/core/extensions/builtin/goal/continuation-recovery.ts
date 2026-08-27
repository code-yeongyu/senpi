export const CONTINUATION_CAP_BLOCKED_REASON = "continuation cap reached";
export const REPETITION_BLOCKED_REASON = "repeated assistant output";
export const LENGTH_EXHAUSTED_BLOCKED_REASON = "output truncation repeated";
export const UNATTENDED_CONTINUATION_BLOCKED_REASON = "unattended continuation limit reached";
export const PROVIDER_ERROR_BLOCKED_REASON = "provider error ended the turn (retries exhausted)";

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
];

const RESUME_GUIDANCE = "Send any message to resume.";

export function isMechanicalContinuationBlock(blockedReason: string | undefined): boolean {
	if (blockedReason === undefined) return false;
	return MECHANICAL_CONTINUATION_BLOCKS.includes(blockedReason);
}

export function continuationCapRecoveryHint(blockedReason: string): string {
	if (!isMechanicalContinuationBlock(blockedReason)) return `Goal continuation blocked: ${blockedReason}`;
	return `Goal continuation blocked: ${blockedReason}. ${RESUME_GUIDANCE}`;
}
