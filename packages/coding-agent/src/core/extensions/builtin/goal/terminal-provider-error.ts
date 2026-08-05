import type { AgentEndEvent } from "../../types.ts";
import { lastAssistantMessage } from "./last-assistant-message.ts";

export function didTerminalProviderErrorEndTurn(event: AgentEndEvent): boolean {
	if (event.abortSource === "system") return false;
	if (event.willRetry !== false) return false;
	const message = lastAssistantMessage(event.messages);
	return message?.stopReason === "error" || (message?.stopReason === "aborted" && event.abortSource === undefined);
}
