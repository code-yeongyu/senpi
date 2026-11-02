// #1733: a wrapped model's thinking streams live; a thinking-only empty stop is then owned by the
// AgentSession turn retry, not replayed inside the stream wrapper.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	FORWARDED_EMPTY_RESPONSE_ERROR,
	getModel,
} from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../../../src/core/agent-session.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createAuthenticatedModelRegistry, getModelRuntime } from "../../model-runtime-test-utils.ts";
import { createTestResourceLoader } from "../../utilities.ts";

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

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
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
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function streamThinkingThen(thinking: string, finalContent: AssistantMessage["content"]): MockAssistantStream {
	const stream = new MockAssistantStream();
	const final = assistantMessage([{ type: "thinking", thinking }, ...finalContent]);
	queueMicrotask(() => {
		const partial: AssistantMessage = { ...final, content: [] };
		stream.push({ type: "start", partial });
		partial.content = [{ type: "thinking", thinking: "" }];
		stream.push({ type: "thinking_start", contentIndex: 0, partial });
		partial.content = [{ type: "thinking", thinking }];
		stream.push({ type: "thinking_delta", contentIndex: 0, delta: thinking, partial });
		stream.push({ type: "thinking_end", contentIndex: 0, content: thinking, partial });
		for (const [offset, block] of finalContent.entries()) {
			if (block.type !== "text") continue;
			const contentIndex = offset + 1;
			partial.content = [...partial.content, { type: "text", text: "" }];
			stream.push({ type: "text_start", contentIndex, partial });
			partial.content = final.content;
			stream.push({ type: "text_delta", contentIndex, delta: block.text, partial });
			stream.push({ type: "text_end", contentIndex, content: block.text, partial });
		}
		stream.push({ type: "done", reason: "stop", message: final });
	});
	return stream;
}

describe("#1733 forwarded thinking-only stop is recovered by the turn retry", () => {
	let session: AgentSession | undefined;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `senpi-1733-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		session = undefined;
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	it("streams the thinking, ends the attempt as a retryable error, and recovers on the retried request", async () => {
		let callCount = 0;
		const streamFn = () => {
			callCount++;
			return callCount === 1
				? streamThinkingThen("Reasoned, then said nothing.", [])
				: streamThinkingThen("Second attempt.", [{ type: "text", text: "Recovered after retry" }]);
		};
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (model === undefined) throw new Error("test model missing from catalog");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn,
		});
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createAuthenticatedModelRegistry(authStorage, tempDir);
		settingsManager.applyOverrides({
			retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, fallbackChains: { "*": [] } },
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
			retryRandom: () => 0,
		});

		const retryEvents: string[] = [];
		const streamedThinking: string[] = [];
		const assistantEnds: AssistantMessage[] = [];
		session.subscribe((event) => {
			if (event.type === "auto_retry_start") retryEvents.push(`start:${event.attempt}:${event.errorMessage}`);
			if (event.type === "auto_retry_end") retryEvents.push(`end:success=${event.success}`);
			if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
				streamedThinking.push(event.assistantMessageEvent.delta);
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				assistantEnds.push(event.message as AssistantMessage);
			}
		});

		await session.prompt("Test");

		expect(callCount).toBe(2);
		expect(streamedThinking).toEqual(["Reasoned, then said nothing.", "Second attempt."]);
		expect(retryEvents).toEqual([`start:1:${FORWARDED_EMPTY_RESPONSE_ERROR}`, "end:success=true"]);
		expect(assistantEnds).toHaveLength(2);
		expect(assistantEnds[0]).toMatchObject({ stopReason: "error", errorMessage: FORWARDED_EMPTY_RESPONSE_ERROR });
		expect(assistantEnds[0].content).toContainEqual(
			expect.objectContaining({ type: "thinking", thinking: "Reasoned, then said nothing." }),
		);
		expect(assistantEnds[1]).toMatchObject({ stopReason: "stop" });
		expect(assistantEnds[1].content).toContainEqual({ type: "text", text: "Recovered after retry" });
		const agentAssistants = agent.state.messages.filter((message) => message.role === "assistant");
		expect(agentAssistants).toHaveLength(1);
		expect(agentAssistants[0]).toMatchObject({ stopReason: "stop" });
		expect(session.isRetrying).toBe(false);
	});
});
