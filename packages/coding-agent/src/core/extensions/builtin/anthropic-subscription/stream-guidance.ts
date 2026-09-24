import { AllAccountsBlockedError } from "./affinity.ts";
import { classifySdkError } from "./errors.ts";
import type { ClaudeCodeRun } from "./executable.ts";
import { allAccountsBlockedGuidance, claudeCodeVersionFloorGuidance, sdkErrorGuidance } from "./guidance.ts";

export function withAuthGuidance(error: unknown, message: string, ran?: ClaudeCodeRun): string {
	if (error instanceof AllAccountsBlockedError)
		return allAccountsBlockedGuidance(error.soonestUnblockAt, error.blockReason);
	const guidance = sdkErrorGuidance(classifySdkError(error).kind);
	const versionGuidance = claudeCodeVersionFloorGuidance(message, ran);
	const hints = [guidance, versionGuidance].filter((hint): hint is string => hint !== undefined);
	return hints.length > 0 ? `${message}\n${hints.join("\n")}` : message;
}
