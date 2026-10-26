import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantProgress,
	type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { pushAssistantProgress } from "../../ai/src/utils/assistant-capture.ts";
import { AssistantMessageEventStream } from "../../ai/src/utils/event-stream.ts";
import { type OrderedAgentRecord } from "../src/internal-events.ts";
import type { AgentTool } from "../src/types.ts";

export const model: Model<"openai-completions"> = {
	id: "fixture",
	name: "fixture",
	api: "openai-completions",
	provider: "fixture",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 100000,
	maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	compat: { toolCallFormat: "kimi-xtml" },
};
export const claude: Model<"anthropic-messages"> = {
	...model,
	id: "claude-sonnet-4-5",
	api: "anthropic-messages",
	compat: undefined,
};
export const bashSchema = { name: "Bash", description: "fixture", parameters: Type.Object({ command: Type.String() }) };
export const bash: AgentTool = {
	...bashSchema,
	label: "Bash",
	execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
};

function message(api: string, modelId: string): AssistantMessage {
	return {
		role: "assistant",
		api,
		provider: "fixture",
		model: modelId,
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
}

export function attempt(signature: string, text: string) {
	const stream = new AssistantMessageEventStream({ captureBlocks: true });
	const output = message(model.api, model.id);
	const pushed: AssistantMessageEvent[] = [];
	const push = (event: AssistantMessageEvent) => {
		pushed.push(event);
		stream.push(event);
	};
	push({ type: "start", partial: output });
	output.content.push({ type: "thinking", thinking: "" });
	push({ type: "thinking_start", contentIndex: 0, partial: output });
	pushAssistantProgress(stream, {
		type: "message_block_metadata",
		contentIndex: 0,
		thinkingSignatureDelta: signature,
	});
	push({ type: "thinking_end", contentIndex: 0, content: "", partial: output });
	if (text) {
		output.content.push({ type: "text", text: "" });
		push({ type: "text_start", contentIndex: 1, partial: output });
		output.content[1] = { type: "text", text };
		push({ type: "text_delta", contentIndex: 1, delta: text, partial: output });
		push({ type: "text_end", contentIndex: 1, content: text, partial: output });
	}
	push({ type: "done", reason: "stop", message: output });
	return { stream, pushed };
}

export function claudeTurnWithInvokeInProse(final: boolean) {
	const stream = new AssistantMessageEventStream({ captureBlocks: true });
	const output = message(claude.api, claude.id);
	stream.push({ type: "start", partial: output });
	if (final) {
		output.content.push({ type: "text", text: "done" });
		stream.push({ type: "text_start", contentIndex: 0, partial: output });
		stream.push({ type: "text_delta", contentIndex: 0, delta: "done", partial: output });
		stream.push({ type: "text_end", contentIndex: 0, content: "done", partial: output });
	} else {
		output.content.push({ type: "thinking", thinking: "" });
		stream.push({ type: "thinking_start", contentIndex: 0, partial: output });
		output.content[0] = { type: "thinking", thinking: "plan", thinkingSignature: "sig" };
		stream.push({ type: "thinking_delta", contentIndex: 0, delta: "plan", partial: output });
		pushAssistantProgress(stream, { type: "message_block_metadata", contentIndex: 0, thinkingSignatureDelta: "sig" });
		stream.push({ type: "thinking_end", contentIndex: 0, content: "plan", partial: output });
		const prose = 'before <invoke name="Bash"><parameter name="command">echo hi</parameter></invoke> after';
		output.content.push({ type: "text", text: "" });
		stream.push({ type: "text_start", contentIndex: 1, partial: output });
		output.content[1] = { type: "text", text: prose };
		stream.push({ type: "text_delta", contentIndex: 1, delta: prose, partial: output });
		stream.push({ type: "text_end", contentIndex: 1, content: prose, partial: output });
		const native = { type: "providerNative" as const, subtype: "web_search_call", raw: { status: "in_progress" } };
		output.content.push(native);
		pushAssistantProgress(stream, { type: "message_block_state", contentIndex: 2, phase: "insert", block: native });
		native.raw = { status: "completed" };
		pushAssistantProgress(stream, { type: "message_block_state", contentIndex: 2, phase: "end", block: native });
	}
	stream.push({ type: "done", reason: "stop", message: output });
	stream.end(output);
	return stream;
}

export function progressOf(records: OrderedAgentRecord[]): AssistantProgress[] {
	return records.flatMap((record) => ("progress" in record ? [record.progress] : []));
}

export function withTimingValuesMasked(progress: AssistantProgress): object {
	if (progress.type !== "message_block_metadata") return progress;
	const { startedAt, endedAt, ...rest } = progress;
	return {
		...rest,
		...(startedAt === undefined ? {} : { startedAt: "set" }),
		...(endedAt === undefined ? {} : { endedAt: "set" }),
	};
}
