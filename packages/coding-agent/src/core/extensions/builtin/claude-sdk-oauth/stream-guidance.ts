import { AllAccountsBlockedError } from "./affinity.ts";
import { classifySdkError } from "./errors.ts";
import { allAccountsBlockedGuidance, claudeCodeVersionFloorGuidance, sdkErrorGuidance } from "./guidance.ts";

export function withAuthGuidance(error: unknown, message: string): string {
	if (error instanceof AllAccountsBlockedError) return allAccountsBlockedGuidance(error.soonestUnblockAt);
	const guidance = sdkErrorGuidance(classifySdkError(error).kind);
	const versionGuidance = claudeCodeVersionFloorGuidance(message);
	const hints = [guidance, versionGuidance].filter((hint): hint is string => hint !== undefined);
	return hints.length > 0 ? `${message}\n${hints.join("\n")}` : message;
}
