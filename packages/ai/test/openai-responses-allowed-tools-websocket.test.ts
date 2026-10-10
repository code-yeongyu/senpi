import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearAllowedToolsChoiceRefusals } from "../src/api/openai-responses-allowed-tools.ts";
import { getModel } from "../src/compat.ts";
import { streamOpenAIResponses } from "../src/providers/openai-responses.ts";
import type { AssistantMessageEvent, Tool } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

type Listener = (event: unknown) => void;
const sentFrames: Array<{ tool_choice?: unknown; tools?: Array<{ name?: string }> }> = [];

// senpi#3080: a WebSocket endpoint that answers an allowed_tools request with an error event.
class RefusingWebSocket {
	private readonly listeners = new Map<string, Set<Listener>>();
	readyState = 1;

	constructor(_url: string, _protocols?: unknown) {
		queueMicrotask(() => this.emit("open", {}));
	}

	send(data: string): void {
		sentFrames.push(JSON.parse(data));
		setTimeout(() => {
			this.emit("message", {
				data: JSON.stringify({
					type: "error",
					error: {
						code: "invalid_value",
						message:
							"Invalid value: 'allowed_tools'. Supported values are: 'function', 'namespace', and 'tool_search'.",
					},
				}),
			});
		}, 0);
	}

	close(): void {
		this.readyState = 3;
		this.emit("close", { code: 1000, reason: "done" });
	}

	addEventListener(type: string, listener: Listener): void {
		const set = this.listeners.get(type) ?? new Set<Listener>();
		set.add(listener);
		this.listeners.set(type, set);
	}

	removeEventListener(type: string, listener: Listener): void {
		this.listeners.get(type)?.delete(listener);
	}

	private emit(type: string, event: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
}

const TOOLS: Tool[] = ["read", "ask_user", "bash"].map((name) => ({
	name,
	description: `${name} tool`,
	parameters: Type.Object({}),
}));

const COMPLETED_SSE = `data: ${JSON.stringify({
	type: "response.completed",
	sequence_number: 0,
	response: {
		id: "resp_ok",
		status: "completed",
		usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 } },
	},
})}\n\ndata: [DONE]\n\n`;

describe("openai-responses allowed_tools refusal over the WebSocket", () => {
	const originalWebSocket = globalThis.WebSocket;
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		clearAllowedToolsChoiceRefusals();
		Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: RefusingWebSocket });
	});

	afterEach(() => {
		sentFrames.length = 0;
		globalThis.fetch = originalFetch;
		Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: originalWebSocket });
	});

	it("retries over HTTP with only the active tools and pushes one start event", async () => {
		const httpBodies: Array<{ tool_choice?: unknown; tools?: Array<{ name?: string }> }> = [];
		globalThis.fetch = async (_input, init) => {
			httpBodies.push(JSON.parse(String(init?.body)));
			return new Response(COMPLETED_SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
		};
		const events: AssistantMessageEvent[] = [];

		const stream = streamOpenAIResponses(
			getModel("openai", "gpt-6.1-sol"),
			normalizeContext({
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: 1 }],
				tools: TOOLS,
				activeToolNames: ["read", "bash"],
			}),
			{ apiKey: "test-key", transport: "auto" },
		);
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect((sentFrames[0]?.tool_choice as { type?: string } | undefined)?.type).toBe("allowed_tools");
		expect(httpBodies).toHaveLength(1);
		expect(httpBodies[0]?.tool_choice).toBeUndefined();
		expect(httpBodies[0]?.tools?.map((tool) => tool.name)).toEqual(["read", "bash"]);
		expect(events.filter((event) => event.type === "start")).toHaveLength(1);
	});
});
