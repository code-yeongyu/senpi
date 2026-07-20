import type { AssistantMessage } from "../types.ts";

/** Returns true when an assistant error was classified as a refusal or sensitive stop. */
export function isClassifierRefusal(message: AssistantMessage): boolean {
	return (
		message.stopReason === "error" &&
		(message.stopDetails?.type === "refusal" || message.stopDetails?.type === "sensitive")
	);
}
