import { describe, expect, it } from "vitest";
import { wrapStreamWithInvokeRecovery } from "../../src/index.ts";
import type { AssistantMessage, AssistantMessageEvent } from "../../src/types.ts";
import { AssistantMessageEventStream } from "../../src/utils/event-stream.ts";
import { runAllMetadataScenario } from "./invoke-recovery-content-exclusion-cases.ts";
import { collectEventSnapshots, MetadataStreamHarness } from "./invoke-recovery-metadata-fixtures.ts";
import {
	ambiguousTools,
	bashTool,
	eventMessage,
	invoke,
	runCollision,
	runText,
	terminal,
	toolEvents,
} from "./invoke-recovery-scenario-fixtures.ts";
import { collectEvents, createAssistantMessage, textFrom } from "./invoke-recovery-stream-fixtures.ts";

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
		expect(result.diagnostics).toEqual([
			{
				type: "text_tool_call_recovery",
				timestamp: expect.any(Number),
				details: {
					protocol: "antml",
					toolName: "Bash",
					id: "recovered-antml-0",
					status: "incomplete",
				},
			},
		]);
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
});
