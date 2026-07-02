import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { EventProjector } from "../../../src/modes/app-server/threads/projection.ts";
import { TurnLog } from "../../../src/modes/app-server/threads/turn-log.ts";

const usage: Usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		responseId: "msg-qa",
		usage,
		stopReason: "stop",
		timestamp: 1,
	};
}

const events: AgentSessionEvent[] = [
	{
		type: "message_update",
		message: assistant([{ type: "thinking", thinking: "" }]),
		assistantMessageEvent: {
			type: "thinking_start",
			contentIndex: 0,
			partial: assistant([{ type: "thinking", thinking: "" }]),
		},
	},
	{
		type: "message_update",
		message: assistant([{ type: "thinking", thinking: "secret-reasoning" }]),
		assistantMessageEvent: {
			type: "thinking_delta",
			contentIndex: 0,
			delta: "secret-reasoning",
			partial: assistant([{ type: "thinking", thinking: "secret-reasoning" }]),
		},
	},
	{
		type: "message_update",
		message: assistant([{ type: "thinking", thinking: "secret-reasoning" }]),
		assistantMessageEvent: {
			type: "thinking_end",
			contentIndex: 0,
			content: "secret-reasoning",
			partial: assistant([{ type: "thinking", thinking: "secret-reasoning" }]),
		},
	},
	{
		type: "message_update",
		message: assistant([{ type: "text", text: "" }]),
		assistantMessageEvent: { type: "text_start", contentIndex: 1, partial: assistant([{ type: "text", text: "" }]) },
	},
	{
		type: "message_update",
		message: assistant([{ type: "text", text: "answer" }]),
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 1,
			delta: "answer",
			partial: assistant([{ type: "text", text: "answer" }]),
		},
	},
];

const turnLog = new TurnLog();
turnLog.recordTurn("thread-qa", { turnId: "turn-qa", startedAt: "2026-07-02T00:00:00.000Z" });
const projector = new EventProjector({
	threadId: "thread-qa",
	turnId: "turn-qa",
	turnLog,
	nowMs: () => 1,
});
const notifications = events.flatMap((event) => projector.project(event).notifications);
const methods = notifications.map((notification) => notification.method);
const agentDeltaPayloads = notifications
	.filter((notification) => notification.method === "item/agentMessage/delta")
	.map((notification) => JSON.stringify(notification.params));
const leaked = agentDeltaPayloads.some((payload) => payload.includes("secret-reasoning"));

console.log(`METHODS=${methods.join(",")}`);
console.log(`LEAK=${leaked}`);

if (!methods.includes("item/reasoning/textDelta") || leaked) {
	process.exitCode = 1;
}
