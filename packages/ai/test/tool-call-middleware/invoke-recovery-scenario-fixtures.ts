import { Type } from "typebox";
import { wrapStreamWithInvokeRecovery } from "../../src/index.ts";
import type { AssistantMessage, AssistantMessageEvent, Tool, ToolCall } from "../../src/types.ts";
import { collectEvents, NativeStreamHarness, TextStreamHarness } from "./invoke-recovery-stream-fixtures.ts";

export const bashTool = {
	name: "Bash",
	description: "Run a command",
	parameters: Type.Object({ command: Type.String({ minLength: 3 }) }),
} satisfies Tool;
export const ambiguousTools = [bashTool, { ...bashTool, name: "bash" }] satisfies Tool[];
export const invoke = '<invoke name="Bash"><parameter name="command">echo recovered</parameter></invoke>';
export const namespacedInvoke =
	'<antml:invoke name="Bash"><antml:parameter name="command">echo recovered</antml:parameter></antml:invoke>';

export function terminal(events: readonly AssistantMessageEvent[]): AssistantMessageEvent[] {
	return events.filter((event) => event.type === "done" || event.type === "error");
}

export function toolEvents(events: readonly AssistantMessageEvent[]): AssistantMessageEvent[] {
	return events.filter((event) => event.type.startsWith("toolcall_"));
}

export function nativeCall(id: string, name = "Native"): ToolCall {
	return { type: "toolCall", id, name, arguments: { value: name } };
}

export async function runChunks(chunks: readonly string[], tools: Tool[] = [bashTool]) {
	const producer = new TextStreamHarness();
	const wrapped = wrapStreamWithInvokeRecovery(producer.inner, tools);
	producer.start();
	for (const chunk of chunks) producer.delta(chunk);
	producer.finish();
	const events = await collectEvents(wrapped);
	return { events, result: await wrapped.result() };
}

export async function runText(input: string, tools: Tool[] = [bashTool]) {
	return runChunks([input], tools);
}

export async function runCollision(order: "native-first" | "recovered-first") {
	const producer = new NativeStreamHarness();
	const wrapped = wrapStreamWithInvokeRecovery(producer.inner, [bashTool]);
	producer.start();
	if (order === "native-first") {
		const index = producer.startNative(nativeCall("recovered-antml-0"));
		producer.endNative(index, nativeCall("recovered-antml-0"));
	}
	const textIndex = producer.startText();
	producer.textDelta(textIndex, invoke);
	producer.endText(textIndex);
	if (order === "recovered-first") {
		const index = producer.startNative(nativeCall("recovered-antml-0", "LateNative"));
		producer.endNative(index, nativeCall("recovered-antml-0", "LateNative"));
	}
	producer.finish();
	const events = await collectEvents(wrapped);
	return { events, result: await wrapped.result() };
}

export function eventMessage(event: AssistantMessageEvent): AssistantMessage {
	if (event.type === "done") return event.message;
	if (event.type === "error") return event.error;
	return event.partial;
}
