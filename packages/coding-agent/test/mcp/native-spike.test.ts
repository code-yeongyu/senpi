// Todo 29 SPIKE — provider response-side block preservation.
//
// Empirically characterises whether provider-native tool-search response
// blocks (Anthropic `server_tool_use` / `tool_search_tool_result`, OpenAI
// `tool_search_call`) survive pi-ai's parse -> persist -> re-serialise cycle
// byte-faithfully. This is the gating evidence for todos 33/34 and the
// backing for MCP/native-search-spike.md.
//
// pi-ai is exercised through its real code via package-source imports; NO
// pi-ai or core file is modified (verified by the git-diff scope check in the
// task-29 evidence log).

import { normalizeContext } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Context, Message, Model } from "@earendil-works/pi-ai/compat";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
// Package-source imports (read-only) into pi-ai internals under test.
import { stream } from "../../../ai/src/api/anthropic-messages.ts";
import { convertResponsesMessages, processResponsesStream } from "../../../ai/src/api/openai-responses-shared.ts";
import { AssistantMessageEventStream } from "../../../ai/src/utils/event-stream.ts";
import {
	anthropicServerToolUseBlock,
	anthropicToolSearchResultBlock,
	asyncIterable,
	buildAnthropicSse,
	buildOpenAiResponseEvents,
	makeMockAnthropicClient,
	openAiToolSearchCallItem,
} from "./fixtures/native-search-mocks.ts";

function userMsg(content: string): Message {
	return { role: "user", content, timestamp: Date.now() };
}

function emptyAssistant(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function drainAnthropicStream(model: Model<"anthropic-messages">, context: Context, sse: string) {
	const mock = makeMockAnthropicClient(sse);
	const result = stream(model, normalizeContext(context), { client: mock.client as never });
	const finalMessage = await result.result();
	const events = result.queue;
	return { finalMessage, events, mock };
}

describe("todo29 spike: Anthropic Messages response-side preservation", () => {
	const model = getModel("anthropic", "claude-sonnet-4-5") as unknown as Model<"anthropic-messages">;

	it("(a) parses unknown server-tool blocks without dropping or crashing", async () => {
		const sse = buildAnthropicSse({
			contentBlocks: [
				{ type: "text", text: "searching" },
				anthropicServerToolUseBlock(),
				anthropicToolSearchResultBlock(),
			],
		});
		const context: Context = { systemPrompt: "sys", messages: [userMsg("find docs tools")] };
		const { finalMessage } = await drainAnthropicStream(model, context, sse);

		const native = finalMessage.content.filter((b) => b.type === "providerNative");
		expect(native.map((b) => (b as { subtype: string }).subtype)).toEqual([
			"server_tool_use",
			"tool_search_tool_result",
		]);
		// The raw block is preserved verbatim (with tool_reference entries intact).
		const searchResult = native.find((b) => (b as { subtype: string }).subtype === "tool_search_tool_result") as {
			raw: { content: { type: string; name: string }[] };
		};
		expect(searchResult.raw.content).toEqual([
			{ type: "tool_reference", name: "mcp_docs_get-library-docs" },
			{ type: "tool_reference", name: "mcp_docs_resolve-library-id" },
		]);
	});

	it("(b) re-serialises the preserved blocks byte-faithfully on the next request", async () => {
		// Reconstruct the assistant turn exactly as (a) parsed it, then feed it
		// back as history and capture the outgoing request payload.
		const serverToolUse = anthropicServerToolUseBlock();
		const toolSearchResult = anthropicToolSearchResultBlock();
		const priorAssistant: AssistantMessage = {
			...emptyAssistant(model),
			content: [
				{ type: "text", text: "searching" },
				{ type: "providerNative", subtype: "server_tool_use", raw: serverToolUse },
				{ type: "providerNative", subtype: "tool_search_tool_result", raw: toolSearchResult },
			],
		};
		const messages: Message[] = [userMsg("find docs tools"), priorAssistant, userMsg("now call the tool")];
		const context: Context = { systemPrompt: "sys", messages };

		const minimalSse = buildAnthropicSse({ contentBlocks: [{ type: "text", text: "ok" }] });
		const { mock } = await drainAnthropicStream(model, context, minimalSse);

		const params = mock.lastParams();
		expect(params).toBeDefined();
		const outMessages = (params as { messages: { role: string; content: unknown[] }[] }).messages;
		const assistantOut = outMessages.find((m) => m.role === "assistant");
		expect(assistantOut).toBeDefined();
		// Both provider-native blocks replay verbatim into the request content.
		expect(assistantOut?.content).toContainEqual(serverToolUse);
		expect(assistantOut?.content).toContainEqual(toolSearchResult);
	});

	it("(c) does not corrupt the render stream — native blocks emit no stray UI events", async () => {
		const sse = buildAnthropicSse({
			contentBlocks: [{ type: "text", text: "hi" }, anthropicServerToolUseBlock(), anthropicToolSearchResultBlock()],
		});
		const context: Context = { systemPrompt: "sys", messages: [userMsg("q")] };
		const { events } = await drainAnthropicStream(model, context, sse);
		const eventTypes = new Set(events.map((e) => e.type));
		// Native blocks are represented in content but have no stream-event
		// variant, so the renderer only ever sees known text events here.
		expect(eventTypes.has("error")).toBe(false);
		for (const type of eventTypes) {
			expect(["start", "text_start", "text_delta", "text_end", "done"]).toContain(type);
		}
	});
});

describe("todo29 spike: OpenAI Responses response-side preservation", () => {
	const model = getModel("openai", "gpt-5.1") as unknown as Model<"openai-responses">;

	it("(a) parses tool_search_call without dropping or crashing", async () => {
		const output = emptyAssistant(model as unknown as Model<Api>) as AssistantMessage;
		const events = buildOpenAiResponseEvents([openAiToolSearchCallItem()]);
		const eventStream = new AssistantMessageEventStream();
		await expect(
			processResponsesStream(asyncIterable(events) as never, output, eventStream, model),
		).resolves.toBeUndefined();

		const native = output.content.filter((b: AssistantMessage["content"][number]) => b.type === "providerNative");
		expect(native).toHaveLength(1);
		expect((native[0] as { subtype: string }).subtype).toBe("tool_search_call");
		expect((native[0] as { raw: { id: string } }).raw.id).toBe("ts_spike_1");
	});

	it("(b) DROPS provider-native blocks on re-serialisation (no round-trip)", () => {
		const priorAssistant: AssistantMessage = {
			...emptyAssistant(model as unknown as Model<Api>),
			content: [
				{ type: "text", text: "searching" },
				{ type: "providerNative", subtype: "tool_search_call", raw: openAiToolSearchCallItem() },
			],
		};
		const context: Context = {
			systemPrompt: "sys",
			messages: [userMsg("find docs tools"), priorAssistant, userMsg("now call the tool")],
		};
		const input = convertResponsesMessages(model, normalizeContext(context), new Set(["openai"]));
		const serialised = JSON.stringify(input);
		// The empty providerNative branch in convertResponsesMessages means the
		// tool_search_call never re-enters the request. This is the seam the
		// spike verdict flags for OpenAI (GO-with-ai-seam).
		expect(serialised).not.toContain("tool_search_call");
		expect(serialised).not.toContain("ts_spike_1");
	});

	it("(c) does not corrupt the render stream for OpenAI native items", async () => {
		const output = emptyAssistant(model as unknown as Model<Api>) as AssistantMessage;
		const eventStream = new AssistantMessageEventStream();
		await processResponsesStream(
			asyncIterable(buildOpenAiResponseEvents([openAiToolSearchCallItem()])) as never,
			output,
			eventStream,
			model,
		);
		const eventTypes = new Set(eventStream.queue.map((e) => e.type));
		expect(eventTypes.has("error")).toBe(false);
	});
});
