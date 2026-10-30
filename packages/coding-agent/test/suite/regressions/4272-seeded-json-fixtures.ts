import { type AssistantMessage, type AssistantMessageEvent, carryAssistantCapture } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";

export const usage = {
	input: 1,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 3,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function assistant(): AssistantMessage {
	return {
		role: "assistant",
		api: "faux",
		provider: "faux",
		model: "fixture",
		content: [],
		timestamp: 1,
		stopReason: "stop",
		usage: { ...usage, cost: { ...usage.cost } },
	};
}

export function update(event: AssistantMessageEvent, outer: object = {}): AgentSessionEvent {
	const message = "partial" in event ? event.partial : event.type === "done" ? event.message : event.error;
	return carryAssistantCapture(event, {
		type: "message_update",
		assistantMessageEvent: event,
		message: { ...message },
		...outer,
	}) as AgentSessionEvent;
}
