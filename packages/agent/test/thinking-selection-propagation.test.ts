import type { AssistantMessage, Message, Model, SimpleStreamOptions, ThinkingSelection } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { agentLoop } from "../src/agent-loop.ts";
import { streamProxy } from "../src/proxy.ts";
import type { AgentContext, AgentLoopConfig, AgentTool } from "../src/types.ts";

function testModel(): Model<"cursor-agent"> {
	return {
		id: "kimi-k3",
		name: "Kimi K3",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "https://api2.cursor.sh",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 64000,
	};
}

const explicitHigh: ThinkingSelection = { level: "high", source: "explicit" };

function assistantMessage(
	stopReason: AssistantMessage["stopReason"],
	content: AssistantMessage["content"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "cursor-agent",
		provider: "cursor",
		model: "kimi-k3",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 0,
	};
}

const echoParameters = Type.Object({ command: Type.String() });
const echoTool: AgentTool<typeof echoParameters> = {
	name: "bash",
	label: "bash",
	description: "run",
	parameters: echoParameters,
	execute: async () => ({ content: [{ type: "text", text: "ran" }], details: {} }),
};

function streamOnce(message: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "start", partial: message });
	stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
	stream.end();
	return stream;
}

describe("agent loop thinkingSelection transitions", () => {
	it("applies value, null, and undefined prepareNextTurn updates across iterations", async () => {
		const seen: (ThinkingSelection | undefined)[] = [];
		const updates: (ThinkingSelection | null | undefined)[] = [{ level: "max", source: "explicit" }, null, undefined];
		const toolCallMessage = assistantMessage("toolUse", [
			{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "true" } },
		]);
		const stopMessage = assistantMessage("stop", [{ type: "text", text: "done" }]);
		let call = 0;
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [echoTool] };
		const config: AgentLoopConfig = {
			model: testModel(),
			convertToLlm: (messages) => messages.filter((message): message is Message => "role" in message),
			thinkingSelection: explicitHigh,
			prepareNextTurn: () => ({ thinkingSelection: updates[call - 1] }),
		};
		const stream = agentLoop(
			[{ role: "user", content: "go", timestamp: 0 }],
			context,
			config,
			undefined,
			(_model, _context, options) => {
				seen.push(options?.thinkingSelection);
				call += 1;
				return streamOnce(call <= 2 ? toolCallMessage : stopMessage);
			},
		);
		await stream.result();
		expect(seen).toEqual([explicitHigh, { level: "max", source: "explicit" }, undefined]);
	});
});

describe("thinking selection propagation", () => {
	async function captureStreamOptions(configure: (agent: Agent) => void) {
		let seen: SimpleStreamOptions | undefined;
		const agent = new Agent({
			streamFn: (_model, _context, options) => {
				seen = options;
				return streamOnce(assistantMessage("stop", [{ type: "text", text: "ok" }]));
			},
		});
		agent.state.model = testModel();
		configure(agent);
		await agent.prompt([{ role: "user", content: "go", timestamp: 0 }]);
		return seen;
	}

	it("passes thinkingSelection from agent state into the provider request", async () => {
		const options = await captureStreamOptions((agent) => {
			agent.state.thinkingLevel = "high";
			agent.state.thinkingSelection = explicitHigh;
		});
		expect(options?.reasoning).toBe("high");
		expect(options?.thinkingSelection).toEqual(explicitHigh);
	});

	it("keeps reasoning undefined for off while preserving explicit off selection", async () => {
		const offSelection: ThinkingSelection = { level: "off", source: "explicit" };
		const options = await captureStreamOptions((agent) => {
			agent.state.thinkingLevel = "off";
			agent.state.thinkingSelection = offSelection;
		});
		expect(options?.reasoning).toBeUndefined();
		expect(options?.thinkingSelection).toEqual(offSelection);
	});

	it("leaves thinkingSelection undefined when nothing was explicitly selected", async () => {
		const options = await captureStreamOptions((agent) => {
			agent.state.thinkingLevel = "medium";
		});
		expect(options?.reasoning).toBe("medium");
		expect(options?.thinkingSelection).toBeUndefined();
	});

	it("serializes thinkingSelection into proxy request options", async () => {
		const options = {
			reasoning: "high" as const,
			thinkingSelection: {
				level: "off",
				source: "legacy-variant",
				legacyVariantId: "gpt-5.6-luna-none",
			} as ThinkingSelection,
			authToken: "token",
			proxyUrl: "https://proxy.example.com",
		};
		const seen: unknown[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
			seen.push(typeof init?.body === "string" ? JSON.parse(init.body) : init?.body);
			return new Response('data: {"type":"error","reason":"error","errorMessage":"closed"}\n\n', {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as typeof fetch;
		try {
			await streamProxy(testModel(), { messages: [] }, options).result();
		} finally {
			globalThis.fetch = originalFetch;
		}
		expect(seen).toHaveLength(1);
		const body = seen[0] as { options?: Record<string, unknown> };
		expect(body?.options?.thinkingSelection).toEqual({
			level: "off",
			source: "legacy-variant",
			legacyVariantId: "gpt-5.6-luna-none",
		});
	});
});
