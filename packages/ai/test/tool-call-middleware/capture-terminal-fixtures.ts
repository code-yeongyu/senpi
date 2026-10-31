import { Type } from "typebox";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Model,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../../src/types.ts";
import {
	type AssistantRecord,
	getAssistantCapture,
	isAssistantProgress,
	pushAssistantProgress,
} from "../../src/utils/assistant-capture.ts";
import { AssistantMessageEventStream } from "../../src/utils/event-stream.ts";
import { SERVER_FALLBACK_ABORTED_DIAGNOSTIC } from "../../src/utils/server-fallback-receipt.ts";
import { createAssistantMessage } from "./invoke-recovery-stream-fixtures.ts";

export const tool = { name: "Bash", description: "fixture", parameters: Type.Object({ command: Type.String() }) };
export const claudeModel: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "fixture",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 100000,
	maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
export const kimiModel: Model<"openai-completions"> = {
	...claudeModel,
	id: "kimi-k2",
	api: "openai-completions",
	provider: "moonshot",
};
const nativeArguments = '{"command":"echo native"}';
const fallbackReceipt = { type: "fallback", from: { model: "a" }, to: { model: "b" } };

export type Ending =
	| "done"
	| "aborted"
	| "superseded"
	| "superseded-error"
	| "invalid-content-order"
	| "invalid-native-order"
	| "collision"
	| "fallback-aborted";

export type Terminal = Extract<AssistantMessageEvent, { type: "done" | "error" }>;

/** Signed thinking at 0, a native call at 1 and plain text at 2: every outer index equals its source index. */
export function nativeCallTurn(ending: Ending): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream({ captureBlocks: true });
	const output = createAssistantMessage([], "pending");
	stream.push({ type: "start", partial: output });
	const thinking: ThinkingContent = { type: "thinking", thinking: "plan" };
	output.content.push(thinking);
	stream.push({ type: "thinking_start", contentIndex: 0, partial: output });
	pushAssistantProgress(stream, { type: "message_block_metadata", contentIndex: 0, thinkingSignatureDelta: "sig" });
	stream.push({ type: "thinking_end", contentIndex: 0, content: "plan", partial: output });
	const call: ToolCall = { type: "toolCall", id: "native", name: "Bash", arguments: {} };
	output.content.push(call);
	stream.push({ type: "toolcall_start", contentIndex: 1, partial: output });
	call.arguments = { command: "echo native" };
	stream.push({ type: "toolcall_delta", contentIndex: 1, delta: nativeArguments, partial: output });
	pushAssistantProgress(stream, {
		type: "message_tool_arguments_reset",
		contentIndex: 1,
		rawArgumentPrefix: nativeArguments,
		parsedThrough: nativeArguments.length,
	});
	stream.push({ type: "toolcall_end", contentIndex: 1, toolCall: call, partial: output });
	const text: TextContent = { type: "text", text: "" };
	output.content.push(text);
	stream.push({ type: "text_start", contentIndex: 2, partial: output });
	text.text = "after";
	stream.push({ type: "text_delta", contentIndex: 2, delta: "after", partial: output });
	stream.push({ type: "text_end", contentIndex: 2, content: "after", partial: output });
	endTurn(stream, output, ending);
	return stream;
}

function endTurn(stream: AssistantMessageEventStream, output: AssistantMessage, ending: Ending): void {
	if (ending === "invalid-native-order") {
		// A delta for a call that already ended is an invalid native order.
		stream.push({ type: "toolcall_delta", contentIndex: 1, delta: "", partial: output });
	} else if (ending === "invalid-content-order") {
		// A delta for text that already ended is an invalid content order.
		stream.push({ type: "text_delta", contentIndex: 2, delta: "", partial: output });
	} else if (ending === "collision") {
		// A native call reusing the id the wrapper gave the call it recovered from prose collides with it. Only its own
		// partial holds it, so the id is not yet visible while the wrapper recovers the prose.
		const prose = '<invoke name="Bash"><parameter name="command">echo hi</parameter></invoke>';
		output.content.push({ type: "text", text: "" });
		stream.push({ type: "text_start", contentIndex: 3, partial: output });
		output.content[3] = { type: "text", text: prose };
		stream.push({ type: "text_delta", contentIndex: 3, delta: prose, partial: output });
		stream.push({ type: "text_end", contentIndex: 3, content: prose, partial: output });
		const twin: ToolCall = { type: "toolCall", id: "recovered-antml-0", name: "Bash", arguments: {} };
		stream.push({
			type: "toolcall_start",
			contentIndex: 4,
			partial: { ...output, content: [...output.content, twin] },
		});
	} else if (ending === "aborted") {
		output.stopReason = "aborted";
		stream.push({ type: "error", reason: "aborted", error: output });
	} else if (ending === "fallback-aborted") {
		// Its own message: the live partials the wrapper has not read yet must keep their blocks.
		const diagnostics = [{ type: SERVER_FALLBACK_ABORTED_DIAGNOSTIC, timestamp: 0, details: {} }];
		const error: AssistantMessage = { ...output, content: [], stopReason: "error", diagnostics };
		stream.push({ type: "error", reason: "error", error });
		stream.end(error);
		return;
	} else {
		// A receipt appended without an event supersedes every client tool call before it.
		if (ending === "superseded" || ending === "superseded-error")
			output.content.push({ type: "providerNative", subtype: "fallback", raw: fallbackReceipt });
		if (ending === "superseded-error") {
			output.stopReason = "error";
			stream.push({ type: "error", reason: "error", error: output });
		} else {
			output.stopReason = "toolUse";
			stream.push({ type: "done", reason: "toolUse", message: output });
		}
	}
	stream.end(output);
}

export function terminalOf(events: AssistantMessageEvent[]): Terminal {
	const terminal = events.at(-1);
	if (terminal?.type !== "done" && terminal?.type !== "error") throw new Error("no terminal event");
	return terminal;
}

export function terminalContent(event: Terminal): AssistantMessage {
	return event.type === "done" ? event.message : event.error;
}

export function carryingRecords(records: AssistantRecord[]): AssistantRecord[] {
	return records.filter((record) => isAssistantProgress(record) || getAssistantCapture(record) !== undefined);
}
