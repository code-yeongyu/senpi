import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { wrapStreamWithInvokeRecovery } from "../../src/index.ts";
import { ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH } from "../../src/tool-call-middleware/protocols/anthropic-xml/stream-boundary.ts";
import { createAntmlInvokeRecoveryStreamParser } from "../../src/tool-call-middleware/protocols/antml/recovery-stream.ts";
import type { AssistantMessage, AssistantMessageEvent, Tool, ToolCall } from "../../src/types.ts";
import { AssistantMessageEventStream } from "../../src/utils/event-stream.ts";
import { runAllMetadataScenario } from "./invoke-recovery-content-exclusion-cases.ts";
import { collectEventSnapshots, MetadataStreamHarness } from "./invoke-recovery-metadata-fixtures.ts";
import {
	collectEvents,
	createAssistantMessage,
	NativeStreamHarness,
	TextStreamHarness,
	textFrom,
} from "./invoke-recovery-stream-fixtures.ts";

const bashTool = {
	name: "Bash",
	description: "Run a command",
	parameters: Type.Object({ command: Type.String({ minLength: 3 }) }),
} satisfies Tool;
const ambiguousTools = [bashTool, { ...bashTool, name: "bash" }] satisfies Tool[];
const invoke = '<invoke name="Bash"><parameter name="command">echo recovered</parameter></invoke>';
const namespacedInvoke =
	'<antml:invoke name="Bash"><antml:parameter name="command">echo recovered</antml:parameter></antml:invoke>';

function terminal(events: readonly AssistantMessageEvent[]): AssistantMessageEvent[] {
	return events.filter((event) => event.type === "done" || event.type === "error");
}

function toolEvents(events: readonly AssistantMessageEvent[]): AssistantMessageEvent[] {
	return events.filter((event) => event.type.startsWith("toolcall_"));
}

function nativeCall(id: string, name = "Native"): ToolCall {
	return { type: "toolCall", id, name, arguments: { value: name } };
}

async function runChunks(chunks: readonly string[], tools: Tool[] = [bashTool]) {
	const producer = new TextStreamHarness();
	const wrapped = wrapStreamWithInvokeRecovery(producer.inner, tools);
	producer.start();
	for (const chunk of chunks) producer.delta(chunk);
	producer.finish();
	const events = await collectEvents(wrapped);
	return { events, result: await wrapped.result() };
}

async function runText(input: string, tools: Tool[] = [bashTool]) {
	return runChunks([input], tools);
}

async function runCollision(order: "native-first" | "recovered-first") {
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

function eventMessage(event: AssistantMessageEvent): AssistantMessage {
	if (event.type === "done") return event.message;
	if (event.type === "error") return event.error;
	return event.partial;
}

describe("invoke recovery Metis and Momus scenarios", () => {
	it("preserves mixed native recovered order and all metadata across every partial", async () => {
		const { events, result } = await runAllMetadataScenario(bashTool);
		const expectedUsage = JSON.stringify(result.usage);
		const indexed = events.filter(
			(event): event is AssistantMessageEvent & { contentIndex: number; partial: AssistantMessage } =>
				"contentIndex" in event && "partial" in event,
		);

		expect(events.map((event) => event.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"text_delta",
			"text_end",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"thinking_start",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_end",
			"done",
		]);
		for (const [position, event] of events.entries()) {
			const message = eventMessage(event);
			expect(JSON.stringify(message.usage), `usage at event ${position}`).toBe(expectedUsage);
			expect(message).toMatchObject({
				responseModel: "claude-routed",
				responseId: "msg-response-9",
				timestamp: 9009,
				fixtureMetadata: { traceId: "trace-9", labels: ["metadata", "stable-order"] },
			});
			expect(message.diagnostics?.[0]).toEqual({
				type: "existing_diagnostic",
				timestamp: 9,
				details: { retained: true },
			});
		}
		for (const [position, event] of indexed.entries()) {
			expect(event.contentIndex, `partial index ${position}`).toBeLessThan(event.partial.content.length);
		}
		expect(result.content.map((block) => block.type)).toEqual([
			"text",
			"toolCall",
			"text",
			"thinking",
			"providerNative",
			"thinking",
			"text",
			"toolCall",
		]);
		expect(result.content[0]).toEqual({ type: "text", text: "before ", textSignature: "signed-text-9" });
		expect(result.content[3]).toMatchObject({ thinkingSignature: "thinking-signature-9" });
		expect(result.content[5]).toMatchObject({ thinkingSignature: "redacted-payload-9", redacted: true });
		expect(result.diagnostics?.map((diagnostic) => diagnostic.type)).toEqual([
			"existing_diagnostic",
			"text_tool_call_recovery",
		]);
	});

	it.each([
		["native-before", "native-first"],
		["recovered-before", "recovered-first"],
	] as const)("preserves %s mixed ordering contract", async (_label, order) => {
		const output = await runCollision(order);
		if (order === "native-first") {
			expect(output.result.content.filter((block) => block.type === "toolCall").map((block) => block.id)).toEqual([
				"recovered-antml-0",
				"recovered-antml-1",
			]);
			expect(terminal(output.events)).toHaveLength(1);
		} else {
			expect(output.result.stopReason).toBe("error");
			expect(output.result.content.filter((block) => block.type === "toolCall")).toEqual([]);
		}
	});

	it("fails closed on recovered-first late native ID collision", async () => {
		const { events, result } = await runCollision("recovered-first");
		expect(terminal(events)).toEqual([expect.objectContaining({ type: "error", reason: "error" })]);
		expect(toolEvents(events).map((event) => event.type)).toEqual([
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
		]);
		expect(result).toMatchObject({ stopReason: "error", errorMessage: "Tool call ID collision in provider stream" });
		expect(result.content.filter((block) => block.type === "toolCall")).toEqual([]);
		expect(result.diagnostics).toEqual([
			{
				type: "text_tool_call_recovery_collision",
				timestamp: expect.any(Number),
				details: { protocol: "antml", status: "collision" },
			},
		]);
	});

	it("keeps excluded and ambiguous content non-executable", async () => {
		const ambiguousInvoke = '<invoke name="BASH"><parameter name="command">echo ambiguous</parameter></invoke>';
		const excluded = `${ambiguousInvoke}\ninline \`${invoke}\`\n\`\`\`xml\n${invoke}\n\`\`\``;
		const producer = new MetadataStreamHarness();
		const wrapped = wrapStreamWithInvokeRecovery(producer.inner, ambiguousTools);
		producer.start();
		const thinking = producer.startThinking({ type: "thinking", thinking: "", thinkingSignature: "sig" });
		producer.thinkingDelta(thinking, invoke);
		producer.endThinking(thinking);
		producer.appendProviderNative({ type: "providerNative", subtype: "fixture", raw: { invoke } });
		const text = producer.startText({ type: "text", text: "" });
		producer.textDelta(text, excluded);
		producer.endText(text);
		producer.finish("stop");
		const events = await collectEventSnapshots(wrapped);
		const result = await wrapped.result();
		expect(toolEvents(events)).toEqual([]);
		expect(result.content.filter((block) => block.type === "toolCall")).toEqual([]);
		expect(result.diagnostics).toEqual([{ type: "existing_diagnostic", timestamp: 9, details: { retained: true } }]);
		expect(textFrom(result)).toBe(excluded);
	});

	it("marks coercion failure incomplete", async () => {
		const { events, result } = await runText('<invoke name="Bash"><parameter name="command">42</parameter></invoke>');
		expect(toolEvents(events).map((event) => event.type)).toEqual([
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
		]);
		expect(result.content).toEqual([expect.objectContaining({ type: "toolCall", arguments: {}, incomplete: true })]);
		expect(JSON.stringify(result.diagnostics)).not.toContain("42");
	});

	it("preserves caller abort after start and completion", async () => {
		for (const [label, xml, includeEnd] of [
			["start", '<invoke name="Bash"><parameter name="command">echo partial', false],
			["completion", invoke, true],
		] as const) {
			const inner = new AssistantMessageEventStream();
			const wrapped = wrapStreamWithInvokeRecovery(inner, [bashTool]);
			const partial = createAssistantMessage([{ type: "text", text: xml }]);
			inner.push({ type: "start", partial: createAssistantMessage([]) });
			inner.push({
				type: "text_start",
				contentIndex: 0,
				partial: createAssistantMessage([{ type: "text", text: "" }]),
			});
			inner.push({ type: "text_delta", contentIndex: 0, delta: xml, partial });
			if (includeEnd) inner.push({ type: "text_end", contentIndex: 0, content: xml, partial });
			const aborted = { ...partial, stopReason: "aborted" as const, errorMessage: "Request was aborted" };
			inner.push({ type: "error", reason: "aborted", error: aborted });
			const events = await collectEvents(wrapped);
			const result = await wrapped.result();
			expect(terminal(events), label).toEqual([expect.objectContaining({ type: "error", reason: "aborted" })]);
			expect(result.stopReason, label).toBe("aborted");
			expect(
				result.content.filter((block) => block.type === "toolCall"),
				label,
			).toEqual([]);
		}
	});

	it("recovers complete calls on non-abort transport errors", async () => {
		const inner = new AssistantMessageEventStream();
		const wrapped = wrapStreamWithInvokeRecovery(inner, [bashTool]);
		const partial = createAssistantMessage([{ type: "text", text: invoke }]);
		inner.push({ type: "start", partial: createAssistantMessage([]) });
		inner.push({
			type: "text_start",
			contentIndex: 0,
			partial: createAssistantMessage([{ type: "text", text: "" }]),
		});
		inner.push({ type: "text_delta", contentIndex: 0, delta: invoke, partial });
		inner.push({ type: "text_end", contentIndex: 0, content: invoke, partial });
		inner.push({
			type: "error",
			reason: "error",
			error: { ...partial, stopReason: "error", errorMessage: "transport" },
		});
		const events = await collectEvents(wrapped);
		const result = await wrapped.result();
		expect(terminal(events)).toEqual([expect.objectContaining({ type: "done", reason: "toolUse" })]);
		expect(result.content).toContainEqual(
			expect.objectContaining({ type: "toolCall", arguments: { command: "echo recovered" } }),
		);
	});

	it("keeps bare and namespaced recovery stable across exhaustive split points", async () => {
		for (const input of [invoke, namespacedInvoke]) {
			for (let split = 0; split <= input.length; split += 1) {
				const { events, result } = await runChunks([input.slice(0, split), input.slice(split)]);
				expect(
					toolEvents(events).map((event) => event.type),
					`split ${split}`,
				).toEqual(["toolcall_start", "toolcall_delta", "toolcall_end"]);
				expect(result.content, `split ${split}`).toEqual([
					{ type: "toolCall", id: "recovered-antml-0", name: "Bash", arguments: { command: "echo recovered" } },
				]);
			}
		}
	});

	it.each([
		["bare", invoke, true],
		["namespaced", namespacedInvoke, true],
		[
			"unsupported namespace",
			'<foo:invoke name="Bash"><foo:parameter name="command">echo nope</foo:parameter></foo:invoke>',
			false,
		],
		["arbitrary tag", '<tool name="Bash"><parameter name="command">echo nope</parameter></tool>', false],
	] as const)("handles %s forms without generic tag inference", async (_label, input, recovered) => {
		const { events, result } = await runText(input);
		expect(toolEvents(events).length > 0).toBe(recovered);
		expect(result.content.some((block) => block.type === "toolCall")).toBe(recovered);
		if (!recovered) expect(textFrom(result)).toBe(input);
	});

	it("preserves byte-identical full usage on every event and terminal", async () => {
		const producer = new MetadataStreamHarness();
		const wrapped = wrapStreamWithInvokeRecovery(producer.inner, [bashTool]);
		producer.start();
		const index = producer.startText({ type: "text", text: "", textSignature: "signed" });
		producer.textDelta(index, invoke);
		producer.endText(index);
		producer.finish();
		const events = await collectEventSnapshots(wrapped);
		const result = await wrapped.result();
		const expected = JSON.stringify(result.usage);
		for (const event of events) expect(JSON.stringify(eventMessage(event).usage)).toBe(expected);
	});

	it("bounds recovery buffers and scan work", () => {
		const onError = vi.fn();
		const parser = createAntmlInvokeRecoveryStreamParser([bashTool], { onError });
		const opening = '<invoke name="';
		const overflow = opening + "x".repeat(ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH - opening.length);
		const events = [...parser.feed(overflow), ...parser.feed(invoke), ...parser.finish()];
		expect(onError).toHaveBeenCalledWith("ANTML recovery fragment exceeded the retained-input limit.", {
			protocol: "antml",
			retainedLength: ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH,
		});
		expect(events.filter((event) => event.type === "toolcall_start")).toHaveLength(1);
		expect(events.filter((event) => event.type === "toolcall_end")).toEqual([
			expect.objectContaining({ arguments: { command: "echo recovered" } }),
		]);
	});
});
