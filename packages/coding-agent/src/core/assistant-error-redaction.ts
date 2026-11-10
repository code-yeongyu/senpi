import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { redactSensitiveTokenValues } from "./sensitive-output.ts";

function redactErrorText(message: AgentMessage): void {
	if (message.role === "assistant" && message.errorMessage) {
		message.errorMessage = redactSensitiveTokenValues(message.errorMessage);
	}
}

/**
 * Provider error text can echo a value a config reference resolved to (omo#12965). An assistant message carries that
 * text from its first streamed partial to its final form, and the final object is the one agent state keeps and the
 * transcript persists, so every message event is redacted in place before a listener, the transcript or the state
 * reads it.
 */
export function redactAssistantErrorText(event: AgentEvent): void {
	if (event.type !== "message_start" && event.type !== "message_update" && event.type !== "message_end") return;
	redactErrorText(event.message);
	if (event.type !== "message_update") return;
	const update = event.assistantMessageEvent;
	if ("partial" in update) redactErrorText(update.partial);
	else if (update.type === "done") redactErrorText(update.message);
	else redactErrorText(update.error);
}
