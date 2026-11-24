import { type AssistantMessage, type AssistantMessageEvent, EventStream } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent, type AgentEvent, type AgentTool } from "../src/index.ts";

// senpi#4282: a provider error the stream function throws, or one that fails the run between turns, never passed
// the provider stream boundary. The agent classifies and redacts it the same way before any event carries it.

const secret = ["zzfixture", "4282", "thrownQ"].join("");
const modelNotFound = `404 {"error":{"message":"The model \`faux-1\` does not exist","code":"model_not_found"}} x-api-key: ${secret}`;

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function toolUseMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "tool-1", name: "noop", arguments: {} }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

const noop: AgentTool = {
	name: "noop",
	label: "Noop",
	description: "Does nothing",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
};

function recordEvents(agent: Agent): AgentEvent[] {
	const events: AgentEvent[] = [];
	agent.subscribe((event) => {
		events.push(event);
	});
	return events;
}

function lastAssistant(agent: Agent): AssistantMessage {
	const last = agent.state.messages[agent.state.messages.length - 1];
	if (last?.role !== "assistant") throw new Error("Expected assistant message");
	return last;
}

describe("thrown provider errors pass the provider error boundary", () => {
	it("classifies and redacts an error the stream function throws", async () => {
		const agent = new Agent({
			streamFn: () => {
				throw new Error(modelNotFound);
			},
		});
		const events = recordEvents(agent);

		await agent.prompt("hello");

		const last = lastAssistant(agent);
		expect(last.stopReason).toBe("error");
		expect(last.errorCause).toMatchObject({ type: "model_config" });
		expect(last.errorMessage).toContain("model_not_found");
		expect(JSON.stringify(events)).not.toContain(secret);
		expect(agent.state.errorMessage).not.toContain(secret);
	});

	it("classifies and redacts an error that fails the run between turns", async () => {
		const agent = new Agent({
			initialState: { tools: [noop] },
			prepareNextTurnWithContext: async () => {
				throw new Error(modelNotFound);
			},
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => stream.push({ type: "done", reason: "toolUse", message: toolUseMessage() }));
				return stream;
			},
		});
		const events = recordEvents(agent);

		await agent.prompt("hello");

		const last = lastAssistant(agent);
		expect(last.stopReason).toBe("error");
		expect(last.errorCause).toMatchObject({ type: "model_config" });
		expect(JSON.stringify(events)).not.toContain(secret);
		expect(agent.state.errorMessage).not.toContain(secret);
	});

	it("leaves an aborted run unclassified", async () => {
		const agent = new Agent({
			streamFn: () => {
				agent.abort();
				throw new Error(modelNotFound);
			},
		});

		await agent.prompt("hello");

		const last = lastAssistant(agent);
		expect(last.stopReason).toBe("aborted");
		expect(last.errorCause).toBeUndefined();
		expect(last.errorMessage).not.toContain(secret);
	});
});
