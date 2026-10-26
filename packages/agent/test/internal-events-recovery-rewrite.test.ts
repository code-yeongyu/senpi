import {
	type AssistantMessage,
	type AssistantMessageEvent,
	getAssistantCapture,
	type Model,
	subscribeAssistantCapture,
	wrapStreamWithModelRecovery,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssistantMessageEventStream } from "../../ai/src/utils/event-stream.ts";
import { Agent } from "../src/agent.ts";
import { type OrderedAgentRecord, createInternalAgentChannel } from "../src/internal-events.ts";
import type { AgentTool } from "../src/types.ts";

const claude: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "fixture",
	api: "anthropic-messages",
	provider: "fixture",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 100000,
	maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const bashSchema = { name: "Bash", description: "fixture", parameters: Type.Object({ command: Type.String() }) };
const bash: AgentTool = {
	...bashSchema,
	label: "Bash",
	execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
};

let releaseCapture = () => {};
beforeEach(() => {
	releaseCapture = subscribeAssistantCapture();
});
afterEach(() => releaseCapture());

/** Aborted: a native call at 1 before text at 2, and the terminal drops the call, so the text moves to 1. */
function nativeCallThenText(ending: "aborted" | "stop") {
	const stream = new AssistantMessageEventStream({ captureBlocks: true });
	const output: AssistantMessage = {
		role: "assistant",
		api: claude.api,
		provider: claude.provider,
		model: claude.id,
		timestamp: 1,
		content: [],
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const push = (event: AssistantMessageEvent) => stream.push(event);
	push({ type: "start", partial: output });
	output.content.push({ type: "thinking", thinking: "plan", thinkingSignature: "sig" });
	push({ type: "thinking_start", contentIndex: 0, partial: output });
	push({ type: "thinking_end", contentIndex: 0, content: "plan", partial: output });
	if (ending === "aborted") {
		const call = { type: "toolCall" as const, id: "native", name: "Bash", arguments: { command: "echo" } };
		output.content.push(call);
		push({ type: "toolcall_start", contentIndex: 1, partial: output });
		push({ type: "toolcall_end", contentIndex: 1, toolCall: call, partial: output });
	}
	const index = output.content.length;
	output.content.push({ type: "text", text: "after" });
	push({ type: "text_start", contentIndex: index, partial: output });
	push({ type: "text_delta", contentIndex: index, delta: "after", partial: output });
	push({ type: "text_end", contentIndex: index, content: "after", partial: output });
	output.stopReason = ending;
	push(
		ending === "aborted"
			? { type: "error", reason: "aborted", error: output }
			: { type: "done", reason: "stop", message: output },
	);
	stream.end(output);
	return stream;
}

async function assistantEnd(ending: "aborted" | "stop") {
	const internalChannel = createInternalAgentChannel();
	const agent = new Agent({
		internalChannel,
		initialState: { model: claude, tools: [bash] },
		streamFn: () => wrapStreamWithModelRecovery(nativeCallThenText(ending), claude, [bashSchema]),
	});
	const records: OrderedAgentRecord[] = [];
	const unsubscribe = internalChannel.subscribe((record) => {
		records.push(record);
	});
	try {
		await agent.prompt("fixture");
	} finally {
		unsubscribe();
	}
	const end = records.find(
		(record) => "event" in record && record.event.type === "message_end" && record.event.message.role === "assistant",
	);
	if (!end || !("event" in end) || end.event.type !== "message_end" || end.event.message.role !== "assistant")
		throw new Error("no assistant message_end");
	return { event: end.event, message: end.event.message };
}

describe("the internal agent channel keeps a recovery terminal's rewrite mark #4272", () => {
	it("carries rewrittenFrom through empty-assistant recovery and the loop onto message_end", async () => {
		const { event, message } = await assistantEnd("aborted");
		expect(message.content.map((block) => block.type)).toEqual(["thinking", "text"]);
		expect(getAssistantCapture(event)?.rewrittenFrom).toBe(1);
	});

	it("marks no rewrite on the message_end of a completed turn", async () => {
		const { event } = await assistantEnd("stop");
		expect(getAssistantCapture(event)).toBeDefined();
		expect(getAssistantCapture(event)?.rewrittenFrom).toBeUndefined();
	});
});
