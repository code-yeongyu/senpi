import { type AssistantMessage, type AssistantMessageEvent, EventStream } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { attachProviderDiagnostic } from "../../ai/src/utils/provider-diagnostic-carrier.ts";
import { Agent, type AgentEvent, type AgentTool } from "../src/index.ts";

// senpi#2197: the agent carries a provider adapter's providerDiagnostic unchanged onto the
// terminal assistant message and into AgentState alongside errorMessage.

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

function failedMessage(extra: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
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
		stopReason: "error",
		errorMessage: "429 rate limited",
		timestamp: Date.now(),
		...extra,
	};
}

function lastAssistant(agent: Agent): AssistantMessage {
	const last = agent.state.messages[agent.state.messages.length - 1];
	if (last?.role !== "assistant") throw new Error("Expected assistant message");
	return last;
}

describe("Agent providerDiagnostic propagation", () => {
	it("keeps an adapter-emitted diagnostic on message_end and mirrors it into state", async () => {
		const diagnostic = {
			category: "rate_limit",
			httpStatus: 429,
			code: "rate_limit_error",
			evidence: "structured_code",
		} as const;
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({
						type: "error",
						reason: "error",
						error: failedMessage({ providerDiagnostic: diagnostic }),
					});
				});
				return stream;
			},
		});
		const ends: AgentEvent[] = [];
		agent.subscribe((event) => {
			if (event.type === "message_end") ends.push(event);
		});

		await agent.prompt("hello");

		expect(lastAssistant(agent).providerDiagnostic).toEqual(diagnostic);
		const assistantEnd = ends.find((event) => event.type === "message_end" && event.message.role === "assistant");
		expect(
			assistantEnd?.type === "message_end" && assistantEnd.message.role === "assistant"
				? assistantEnd.message.providerDiagnostic
				: undefined,
		).toEqual(diagnostic);
		expect(agent.state.errorMessage).toBe("429 rate limited");
		expect(agent.state.providerDiagnostic).toEqual(diagnostic);
	});

	it("carries the diagnostic attached to a thrown provider error onto the terminal message", async () => {
		const diagnostic = {
			category: "auth",
			httpStatus: 401,
			code: "authentication_error",
			evidence: "structured_code",
		} as const;
		const agent = new Agent({
			streamFn: () => {
				throw attachProviderDiagnostic(new Error("401 invalid x-api-key"), diagnostic);
			},
		});

		await agent.prompt("hello");

		const last = lastAssistant(agent);
		expect(last.stopReason).toBe("error");
		expect(last.errorMessage).toBe("401 invalid x-api-key");
		expect(last.providerDiagnostic).toEqual(diagnostic);
		expect(agent.state.providerDiagnostic).toEqual(diagnostic);
	});

	it("carries the diagnostic of a provider error that fails the run between turns", async () => {
		const diagnostic = {
			category: "quota",
			httpStatus: 429,
			code: "insufficient_quota",
			evidence: "structured_code",
		} as const;
		const tool: AgentTool = {
			name: "noop",
			label: "Noop",
			description: "Does nothing",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
		};
		const agent = new Agent({
			initialState: { tools: [tool] },
			prepareNextTurnWithContext: async () => {
				throw attachProviderDiagnostic(new Error("summary request failed"), diagnostic);
			},
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: failedMessage({
							stopReason: "toolUse",
							errorMessage: undefined,
							content: [{ type: "toolCall", id: "tool-1", name: "noop", arguments: {} }],
						}),
					});
				});
				return stream;
			},
		});

		await agent.prompt("hello");

		const last = lastAssistant(agent);
		expect(last.errorMessage).toBe("summary request failed");
		expect(last.providerDiagnostic).toEqual(diagnostic);
		expect(agent.state.providerDiagnostic).toEqual(diagnostic);
	});

	it("does not pair a new diagnostic-less failure with a stale diagnostic", async () => {
		let call = 0;
		const agent = new Agent({
			streamFn: () => {
				call += 1;
				if (call === 1) {
					throw attachProviderDiagnostic(new Error("first"), {
						category: "auth",
						httpStatus: 401,
						evidence: "structured_status",
					});
				}
				throw new Error("second, local failure");
			},
		});

		await agent.prompt("one");
		expect(agent.state.providerDiagnostic?.category).toBe("auth");
		await agent.prompt("two");

		expect(agent.state.errorMessage).toBe("second, local failure");
		expect(agent.state.providerDiagnostic).toBeUndefined();
		expect(lastAssistant(agent).providerDiagnostic).toBeUndefined();
	});

	it("drops a forged diagnostic when mirroring into state", async () => {
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({
						type: "error",
						reason: "error",
						error: failedMessage({
							providerDiagnostic: { category: "quota", httpStatus: 401, evidence: "structured_status" },
						}),
					});
				});
				return stream;
			},
		});

		await agent.prompt("hello");

		expect(agent.state.errorMessage).toBe("429 rate limited");
		expect(agent.state.providerDiagnostic).toBeUndefined();
	});
});
