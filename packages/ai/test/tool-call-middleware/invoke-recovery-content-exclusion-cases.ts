import { expect, it } from "vitest";
import { wrapStreamWithInvokeRecovery } from "../../src/index.ts";
import type { AssistantMessage, AssistantMessageEvent, Tool, ToolCall } from "../../src/types.ts";
import {
	collectEventSnapshots,
	type MetadataAssistantMessage,
	MetadataStreamHarness,
} from "./invoke-recovery-metadata-fixtures.ts";

const invoke = '<invoke name="Bash"><parameter name="command">echo recovered</parameter></invoke>';
const excludedInvoke = '<invoke name="Bash"><parameter name="command">echo excluded</parameter></invoke>';
const codeText = `inline \`${excludedInvoke}\`\n\`\`\`xml\n${excludedInvoke}\n\`\`\``;
const nativeCall: ToolCall = {
	type: "toolCall",
	id: "toolu-native-9",
	name: "Native",
	arguments: { path: "native.ts" },
	thoughtSignature: "native-thought-9",
};

function messageFromEvent(event: AssistantMessageEvent): AssistantMessage {
	if (event.type === "done") return event.message;
	if (event.type === "error") return event.error;
	return event.partial;
}

function expectFullMetadata(message: AssistantMessage): void {
	const metadataMessage = message as MetadataAssistantMessage;
	expect({
		api: message.api,
		provider: message.provider,
		model: message.model,
		responseModel: message.responseModel,
		responseId: message.responseId,
		usage: message.usage,
		timestamp: message.timestamp,
		fixtureMetadata: metadataMessage.fixtureMetadata,
	}).toEqual({
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-requested",
		responseModel: "claude-routed",
		responseId: "msg-response-9",
		usage: {
			input: 101,
			output: 37,
			cacheRead: 23,
			cacheWrite: 19,
			cacheWrite1h: 17,
			reasoning: 11,
			totalTokens: 180,
			cost: { input: 0.101, output: 0.037, cacheRead: 0.023, cacheWrite: 0.019, total: 0.18 },
		},
		timestamp: 9009,
		fixtureMetadata: { traceId: "trace-9", labels: ["metadata", "stable-order"] },
	});
	expect(message.diagnostics?.[0]).toEqual({
		type: "existing_diagnostic",
		timestamp: 9,
		details: { retained: true },
	});
}

async function runAllMetadataScenario(tool: Tool) {
	const producer = new MetadataStreamHarness();
	const wrapped = wrapStreamWithInvokeRecovery(producer.inner, [tool]);
	producer.start();
	const signedText = producer.startText({ type: "text", text: "", textSignature: "signed-text-9" });
	producer.textDelta(signedText, `before ${invoke} after`);
	producer.endText(signedText);
	const thinking = producer.startThinking({
		type: "thinking",
		thinking: "",
		thinkingSignature: "thinking-signature-9",
	});
	producer.thinkingDelta(thinking, excludedInvoke);
	producer.endThinking(thinking);
	producer.appendProviderNative({
		type: "providerNative",
		subtype: "server_tool_use",
		raw: { type: "server_tool_use", id: "server-9", input: { bytes: excludedInvoke } },
	});
	const redacted = producer.startThinking({
		type: "thinking",
		thinking: excludedInvoke,
		thinkingSignature: "redacted-payload-9",
		redacted: true,
	});
	producer.endThinking(redacted);
	const code = producer.startText({ type: "text", text: "" });
	producer.textDelta(code, codeText);
	producer.endText(code);
	const native = producer.startNative({ ...nativeCall, arguments: {} });
	producer.endNative(native, nativeCall);
	producer.finish();
	const events = await collectEventSnapshots(wrapped);
	return { producer, events, result: await wrapped.result() };
}

function indexedEvents(events: readonly AssistantMessageEvent[]) {
	return events.flatMap((event) =>
		"contentIndex" in event ? [{ type: event.type, contentIndex: event.contentIndex, partial: event.partial }] : [],
	);
}

export function registerInvokeRecoveryContentExclusionCases(tool: Tool): void {
	it("preserves all metadata and stable indices across signed text native and recovered blocks", async () => {
		const { producer, events, result } = await runAllMetadataScenario(tool);

		for (const event of events) expectFullMetadata(messageFromEvent(event));
		expectFullMetadata(result);
		for (const [position, event] of indexedEvents(events).entries()) {
			expect(event.contentIndex, `indexed event ${position}`).toBeLessThan(event.partial.content.length);
			if (position > 0) {
				expect(event.contentIndex).toBeGreaterThanOrEqual(indexedEvents(events)[position - 1]!.contentIndex);
			}
		}
		expect(result.content).toEqual([
			{ type: "text", text: "before ", textSignature: "signed-text-9" },
			{ type: "toolCall", id: "recovered-antml-0", name: "Bash", arguments: { command: "echo recovered" } },
			{ type: "text", text: " after" },
			{ type: "thinking", thinking: excludedInvoke, thinkingSignature: "thinking-signature-9" },
			{
				type: "providerNative",
				subtype: "server_tool_use",
				raw: { type: "server_tool_use", id: "server-9", input: { bytes: excludedInvoke } },
			},
			{
				type: "thinking",
				thinking: excludedInvoke,
				thinkingSignature: "redacted-payload-9",
				redacted: true,
			},
			{ type: "text", text: codeText },
			nativeCall,
		]);
		expect(producer.partial.diagnostics).toHaveLength(1);
		expect(producer.partial.content[0]).toMatchObject({ type: "text", text: `before ${invoke} after` });

		const signedOnly = new MetadataStreamHarness();
		const signedOnlyWrapped = wrapStreamWithInvokeRecovery(signedOnly.inner, [tool]);
		signedOnly.start();
		const signedOnlyIndex = signedOnly.startText({ type: "text", text: "", textSignature: "signed-only-9" });
		signedOnly.textDelta(signedOnlyIndex, invoke);
		signedOnly.endText(signedOnlyIndex);
		signedOnly.finish();
		await collectEventSnapshots(signedOnlyWrapped);
		expect((await signedOnlyWrapped.result()).content).toEqual([
			{ type: "text", text: "", textSignature: "signed-only-9" },
			{ type: "toolCall", id: "recovered-antml-0", name: "Bash", arguments: { command: "echo recovered" } },
		]);
	});

	it("never scans thinking redacted thinking code spans or provider-native content", async () => {
		const { events, result } = await runAllMetadataScenario(tool);
		const recovered = result.content.filter(
			(block): block is ToolCall => block.type === "toolCall" && block.id.startsWith("recovered-antml-"),
		);

		expect(recovered).toHaveLength(1);
		expect(recovered[0]?.arguments).toEqual({ command: "echo recovered" });
		expect(result.content.filter((block) => block.type === "thinking")).toEqual([
			{ type: "thinking", thinking: excludedInvoke, thinkingSignature: "thinking-signature-9" },
			{
				type: "thinking",
				thinking: excludedInvoke,
				thinkingSignature: "redacted-payload-9",
				redacted: true,
			},
		]);
		expect(result.content.find((block) => block.type === "providerNative")?.raw).toEqual({
			type: "server_tool_use",
			id: "server-9",
			input: { bytes: excludedInvoke },
		});
		expect(result.content.find((block) => block.type === "text" && block.text === codeText)).toBeDefined();
		expect(result.diagnostics?.map((diagnostic) => diagnostic.type)).toEqual([
			"existing_diagnostic",
			"text_tool_call_recovery",
		]);
		expect(events.filter((event) => event.type === "thinking_start")).toHaveLength(2);
	});

	it("synchronizes unannounced provider-native blocks before later indexed events", async () => {
		const { events } = await runAllMetadataScenario(tool);
		const redactedStart = events.find(
			(event) =>
				event.type === "thinking_start" &&
				event.partial.content[event.contentIndex]?.type === "thinking" &&
				event.partial.content[event.contentIndex]?.redacted === true,
		);

		expect(redactedStart).toMatchObject({ type: "thinking_start", contentIndex: 5 });
		if (redactedStart?.type !== "thinking_start") throw new Error("Expected redacted thinking start");
		expect(redactedStart.partial.content[4]).toEqual({
			type: "providerNative",
			subtype: "server_tool_use",
			raw: { type: "server_tool_use", id: "server-9", input: { bytes: excludedInvoke } },
		});
		expect(redactedStart.partial.content[5]).toMatchObject({
			type: "thinking",
			thinkingSignature: "redacted-payload-9",
			redacted: true,
		});

		const terminalProducer = new MetadataStreamHarness();
		const terminalWrapped = wrapStreamWithInvokeRecovery(terminalProducer.inner, [tool]);
		terminalProducer.start();
		const textIndex = terminalProducer.startText({ type: "text", text: "" });
		terminalProducer.textDelta(textIndex, "terminal text");
		terminalProducer.endText(textIndex);
		terminalProducer.appendProviderNative({ type: "providerNative", subtype: "terminal", raw: { retained: true } });
		terminalProducer.finish("stop");
		await collectEventSnapshots(terminalWrapped);
		expect((await terminalWrapped.result()).content).toEqual([
			{ type: "text", text: "terminal text" },
			{ type: "providerNative", subtype: "terminal", raw: { retained: true } },
		]);
	});
}
