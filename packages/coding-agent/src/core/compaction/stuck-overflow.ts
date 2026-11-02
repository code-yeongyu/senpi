import { type AssistantMessage, isContextOverflow } from "@earendil-works/pi-ai";

/**
 * A turn that context size prevented from producing anything usable: the
 * provider rejected the request outright, or it accepted the request but had no
 * room left for output (truncating providers report a zero-output "length" stop).
 * Such a session cannot move by re-sending the same context, so its recovery
 * runs even when the user switched proactive auto-compaction off (#1422).
 * A completed answer whose usage merely exceeds the window is not stuck.
 */
export function isTurnStuckOnContextOverflow(message: AssistantMessage, contextWindow: number): boolean {
	if (!isContextOverflow(message, contextWindow)) return false;
	if (message.stopReason === "error") return true;
	return message.stopReason === "length" && message.usage.output === 0;
}
