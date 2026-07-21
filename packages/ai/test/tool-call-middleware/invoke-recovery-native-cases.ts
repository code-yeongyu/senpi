import { expect, it } from "vitest";
import { wrapStreamWithInvokeRecovery } from "../../src/index.ts";
import type { AssistantMessageEvent, Tool, ToolCall } from "../../src/types.ts";
import { collectEvents, NativeStreamHarness } from "./invoke-recovery-stream-fixtures.ts";

const leakedInvoke =
	'<antml:invoke name="Bash"><antml:parameter name="command">echo recovered</antml:parameter></antml:invoke>';

function nativeCall(
	id: string,
	name: string,
	argumentsValue: Record<string, unknown>,
	extra: Pick<ToolCall, "thoughtSignature" | "incomplete" | "errorMessage"> = {},
): ToolCall {
	return { type: "toolCall", id, name, arguments: argumentsValue, ...extra };
}

function indexedEvents(events: readonly AssistantMessageEvent[]): Array<{ type: string; contentIndex: number }> {
	return events.flatMap((event) =>
		"contentIndex" in event ? [{ type: event.type, contentIndex: event.contentIndex }] : [],
	);
}

async function runNativeOrderScenario(tool: Tool) {
	const producer = new NativeStreamHarness();
	const wrapped = wrapStreamWithInvokeRecovery(producer.inner, [tool]);
	producer.start();
	const beforeIndex = producer.startNative(
		nativeCall(
			"recovered-antml-0",
			"NativeBefore",
			{},
			{
				thoughtSignature: "sig-before",
			},
		),
	);
	const before = nativeCall(
		"recovered-antml-0",
		"NativeBefore",
		{ command: "echo before" },
		{
			thoughtSignature: "sig-before",
		},
	);
	producer.deltaNative(beforeIndex, '{"command":"echo before"}', before);
	producer.endNative(beforeIndex, before);
	producer.appendProviderNative({
		type: "providerNative",
		subtype: "server_tool_use",
		raw: { type: "server_tool_use", id: "server-1", input: { query: "docs" } },
	});
	const textIndex = producer.startText();
	producer.textDelta(textIndex, `before ${leakedInvoke} after`);
	producer.endText(textIndex);
	const afterIndex = producer.startNative(
		nativeCall(
			"toolu-after",
			"NativeAfter",
			{},
			{
				thoughtSignature: "sig-after",
			},
		),
	);
	const after = nativeCall(
		"toolu-after",
		"NativeAfter",
		{ path: "after.ts" },
		{
			thoughtSignature: "sig-after",
		},
	);
	producer.deltaNative(afterIndex, '{"path":"after.ts"}', after);
	producer.endNative(afterIndex, after);
	producer.finish();
	const events = await collectEvents(wrapped);
	return { events, result: await wrapped.result() };
}

export function registerInvokeRecoveryNativeCases(tool: Tool): void {
	it("preserves native tool calls before and after a recovered leak in source order", async () => {
		const { events, result } = await runNativeOrderScenario(tool);

		expect(result.content).toEqual([
			nativeCall(
				"recovered-antml-0",
				"NativeBefore",
				{ command: "echo before" },
				{
					thoughtSignature: "sig-before",
				},
			),
			{
				type: "providerNative",
				subtype: "server_tool_use",
				raw: { type: "server_tool_use", id: "server-1", input: { query: "docs" } },
			},
			{ type: "text", text: "before " },
			nativeCall("recovered-antml-1", "Bash", { command: "echo recovered" }),
			{ type: "text", text: " after" },
			nativeCall("toolu-after", "NativeAfter", { path: "after.ts" }, { thoughtSignature: "sig-after" }),
		]);
		expect(indexedEvents(events)).toEqual([
			{ type: "toolcall_start", contentIndex: 0 },
			{ type: "toolcall_delta", contentIndex: 0 },
			{ type: "toolcall_end", contentIndex: 0 },
			{ type: "text_start", contentIndex: 2 },
			{ type: "text_delta", contentIndex: 2 },
			{ type: "toolcall_start", contentIndex: 3 },
			{ type: "toolcall_delta", contentIndex: 3 },
			{ type: "toolcall_end", contentIndex: 3 },
			{ type: "text_delta", contentIndex: 4 },
			{ type: "text_end", contentIndex: 4 },
			{ type: "toolcall_start", contentIndex: 5 },
			{ type: "toolcall_delta", contentIndex: 5 },
			{ type: "toolcall_end", contentIndex: 5 },
		]);
	});

	it("skips an already-visible native ID collision", async () => {
		const producer = new NativeStreamHarness();
		const wrapped = wrapStreamWithInvokeRecovery(producer.inner, [tool]);
		producer.start();
		const nativeIndex = producer.startNative(nativeCall("recovered-antml-0", "Native", {}));
		producer.endNative(nativeIndex, nativeCall("recovered-antml-0", "Native", { value: 1 }));
		const textIndex = producer.startText();
		producer.textDelta(textIndex, leakedInvoke);
		producer.endText(textIndex);
		producer.finish();
		const events = await collectEvents(wrapped);
		const result = await wrapped.result();

		expect(result.content.filter((block) => block.type === "toolCall").map((call) => call.id)).toEqual([
			"recovered-antml-0",
			"recovered-antml-1",
		]);
		expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(2);
	});

	it("fails closed when a later native call collides with an emitted recovered ID", async () => {
		const producer = new NativeStreamHarness();
		const wrapped = wrapStreamWithInvokeRecovery(producer.inner, [tool]);
		producer.start();
		const textIndex = producer.startText();
		producer.textDelta(textIndex, leakedInvoke);
		producer.endText(textIndex);
		const nativeIndex = producer.startNative(nativeCall("recovered-antml-0", "NativeCollision", {}));
		producer.endNative(nativeIndex, nativeCall("recovered-antml-0", "NativeCollision", { secret: "hidden" }));
		producer.finish();
		const events = await collectEvents(wrapped);
		const result = await wrapped.result();

		expect(events.filter((event) => event.type === "done")).toEqual([]);
		expect(events.filter((event) => event.type === "error")).toHaveLength(1);
		expect(events.filter((event) => event.type === "toolcall_start")).toHaveLength(1);
		expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(1);
		expect(result).toMatchObject({ stopReason: "error", errorMessage: "Tool call ID collision in provider stream" });
		expect(result.content.filter((block) => block.type === "toolCall")).toEqual([]);
		expect(result.diagnostics).toEqual([
			{
				type: "text_tool_call_recovery_collision",
				timestamp: expect.any(Number),
				details: { protocol: "antml", status: "collision" },
			},
		]);
		expect(JSON.stringify(result.diagnostics)).not.toContain("NativeCollision");
		expect(JSON.stringify(result.diagnostics)).not.toContain("recovered-antml-0");
		expect(JSON.stringify(result.diagnostics)).not.toContain("hidden");
	});

	it("preserves an incomplete native call without mutation", async () => {
		const producer = new NativeStreamHarness();
		const wrapped = wrapStreamWithInvokeRecovery(producer.inner, [tool]);
		const incomplete = nativeCall(
			"toolu-incomplete",
			"NativeIncomplete",
			{ command: "echo partial" },
			{
				incomplete: true,
				errorMessage: "Provider reported incomplete arguments",
				thoughtSignature: "sig-incomplete",
			},
		);
		producer.start();
		const nativeIndex = producer.startNative(
			nativeCall(
				"toolu-incomplete",
				"NativeIncomplete",
				{},
				{
					thoughtSignature: "sig-incomplete",
				},
			),
		);
		producer.deltaNative(nativeIndex, '{"command":"echo partial"', incomplete);
		producer.endNative(nativeIndex, incomplete);
		producer.finish();
		const events = await collectEvents(wrapped);
		const result = await wrapped.result();

		expect(result.content).toEqual([incomplete]);
		expect(events.find((event) => event.type === "toolcall_delta")).toMatchObject({
			type: "toolcall_delta",
			delta: '{"command":"echo partial"',
		});
		expect(events.find((event) => event.type === "toolcall_end")).toMatchObject({
			type: "toolcall_end",
			toolCall: incomplete,
		});
	});
}
