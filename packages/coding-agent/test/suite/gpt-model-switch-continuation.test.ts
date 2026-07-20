// previous_response_id / server-side continuation pin tests (plan todo 4e).
// Decision-rule outcome: GREEN on unchanged code, so NO production invalidation
// code is added. The codex websocket continuation guard requestBodiesMatchExceptInput
// (packages/ai/src/api/openai-codex-responses.ts) compares the whole request body
// minus `input` — including `model` and `tools` — so any model/api switch already
// invalidates the cached continuation in buildCachedWebSocketRequestBody and falls
// back to a full client-side replay without `previous_response_id`.
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	getOpenAICodexWebSocketDebugStats,
	resetOpenAICodexWebSocketDebugStats,
	stream as streamOpenAICodexResponses,
} from "../../../ai/src/api/openai-codex-responses.ts";
import type { Context, Model, Tool } from "../../../ai/src/types.ts";
import { createHarness, type Harness } from "./harness.ts";

interface CodexRequestBody {
	model?: string;
	input?: unknown[];
	previous_response_id?: string;
	store?: boolean;
}

function mockToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function codexModel(id: string): Model<"openai-codex-responses"> {
	return {
		id,
		name: id,
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 128_000,
	};
}

function namedTool(name: string): Tool {
	return { name, description: `${name} tool`, parameters: Type.Object({}) };
}

function stubCodexWebSocket(sentBodies: CodexRequestBody[]): void {
	const responses = [
		{ responseId: "resp_1", messageId: "msg_1", text: "Hello" },
		{ responseId: "resp_2", messageId: "msg_2", text: "Done" },
	];

	class MockWebSocket {
		static OPEN = 1;
		readyState = MockWebSocket.OPEN;
		private listeners = new Map<string, Set<(event: unknown) => void>>();

		constructor(_url: string, _protocols?: string | string[] | { headers?: Record<string, string> }) {
			queueMicrotask(() => this.dispatch("open", {}));
		}

		addEventListener(type: string, listener: (event: unknown) => void): void {
			const listeners = this.listeners.get(type) ?? new Set<(event: unknown) => void>();
			listeners.add(listener);
			this.listeners.set(type, listeners);
		}

		removeEventListener(type: string, listener: (event: unknown) => void): void {
			this.listeners.get(type)?.delete(listener);
		}

		send(data: string): void {
			sentBodies.push(JSON.parse(data) as CodexRequestBody);
			const response = responses.shift();
			if (!response) throw new Error("unexpected websocket request");
			const events = [
				{ type: "response.created", response: { id: response.responseId } },
				{
					type: "response.output_item.done",
					item: {
						type: "message",
						id: response.messageId,
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: response.text }],
					},
				},
				{
					type: "response.completed",
					response: {
						id: response.responseId,
						status: "completed",
						usage: {
							input_tokens: 5,
							output_tokens: 3,
							total_tokens: 8,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			];
			queueMicrotask(() => {
				for (const event of events) {
					this.dispatch("message", { data: JSON.stringify(event) });
				}
			});
		}

		close(): void {
			this.readyState = 3;
		}

		private dispatch(type: string, event: unknown): void {
			for (const listener of this.listeners.get(type) ?? []) {
				listener(event);
			}
		}
	}

	vi.stubGlobal("WebSocket", MockWebSocket);
}

async function establishContinuation(
	sessionId: string,
	model: Model<"openai-codex-responses">,
	tools: Tool[],
	sentBodies: CodexRequestBody[],
): Promise<Context["messages"]> {
	const firstContext: Context = {
		systemPrompt: "You are a helpful assistant.",
		messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
		tools,
	};
	const first = await streamOpenAICodexResponses(model, firstContext, {
		apiKey: mockToken(),
		sessionId,
		transport: "websocket-cached",
	}).result();
	return [...firstContext.messages, first];
}

async function sendFollowUp(
	sessionId: string,
	model: Model<"openai-codex-responses">,
	tools: Tool[],
	messages: Context["messages"],
): Promise<void> {
	await streamOpenAICodexResponses(
		model,
		{
			systemPrompt: "You are a helpful assistant.",
			messages: [...messages, { role: "user", content: "Now finish", timestamp: 2 }],
			tools,
		},
		{ apiKey: mockToken(), sessionId, transport: "websocket-cached" },
	).result();
}

describe("codex continuation state across model switches", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.unstubAllGlobals();
		closeOpenAICodexWebSocketSessions();
		resetOpenAICodexWebSocketDebugStats();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("replays full input without previous_response_id when the tool set changes", async () => {
		// Given: an established websocket-cached continuation for the session.
		const sentBodies: CodexRequestBody[] = [];
		stubCodexWebSocket(sentBodies);
		const sessionId = "switch-tools-session";
		const history = await establishContinuation(sessionId, codexModel("gpt-5.1-codex"), [namedTool("edit")], sentBodies);

		// When: the next request carries the post-switch tool set (apply_patch swapped in).
		await sendFollowUp(sessionId, codexModel("gpt-5.1-codex"), [namedTool("apply_patch")], history);

		// Then: the continuation anchor is dropped and the full history is replayed.
		expect(sentBodies).toHaveLength(2);
		const secondBody = sentBodies[1];
		if (!secondBody) throw new Error("Missing second request body");
		expect(secondBody.previous_response_id).toBeUndefined();
		const replayed = JSON.stringify(secondBody.input);
		expect(replayed).toContain("Say hello");
		expect(replayed).toContain("Now finish");
	});

	it("replays full input without previous_response_id when the model changes", async () => {
		// Given
		const sentBodies: CodexRequestBody[] = [];
		stubCodexWebSocket(sentBodies);
		const sessionId = "switch-model-session";
		const history = await establishContinuation(sessionId, codexModel("gpt-5.1-codex"), [namedTool("edit")], sentBodies);

		// When: the next request targets a different model id on the same endpoint.
		await sendFollowUp(sessionId, codexModel("gpt-5.2-codex"), [namedTool("edit")], history);

		// Then
		expect(sentBodies).toHaveLength(2);
		const secondBody = sentBodies[1];
		if (!secondBody) throw new Error("Missing second request body");
		expect(secondBody.previous_response_id).toBeUndefined();
		const replayed = JSON.stringify(secondBody.input);
		expect(replayed).toContain("Say hello");
		expect(replayed).toContain("Now finish");
	});

	it("keeps continuation state when a model switch fails auth", async () => {
		// Given: an AgentSession whose prior codex traffic established continuation state.
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			withConfiguredAuth: false,
		});
		harnesses.push(harness);
		const sessionId = harness.session.sessionId;
		const sentBodies: CodexRequestBody[] = [];
		stubCodexWebSocket(sentBodies);
		const history = await establishContinuation(sessionId, codexModel("gpt-5.1-codex"), [namedTool("edit")], sentBodies);
		await sendFollowUp(sessionId, codexModel("gpt-5.1-codex"), [namedTool("edit")], history);
		expect(getOpenAICodexWebSocketDebugStats(sessionId)).toMatchObject({
			requests: 2,
			lastPreviousResponseId: "resp_1",
		});

		// When: a model switch is rejected because no auth is configured.
		const target = harness.getModel("faux-2");
		if (!target) throw new Error("Missing faux-2 model");
		await expect(harness.session.setModel(target)).rejects.toThrow("No API key");

		// Then: the continuation cache and the active model are untouched.
		expect(harness.session.model?.id).toBe("faux-1");
		expect(getOpenAICodexWebSocketDebugStats(sessionId)).toMatchObject({
			requests: 2,
			lastPreviousResponseId: "resp_1",
		});
	});
});
