import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	registerFauxProvider,
	type ToolResultMessage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateContextTokens } from "../../src/core/compaction/index.ts";
import compactionExtension from "../../src/core/extensions/builtin/compaction/index.ts";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ContextEvent,
	ContextEventResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
} from "../../src/core/extensions/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

function assistantWithToolCall(id: string, command: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "bash", arguments: { command } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp,
	};
}

function toolResult(id: string, text: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

function userMessage(text: string, timestamp: number): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function createContextHandler(): ExtensionHandler<ContextEvent, ContextEventResult> {
	let contextHandler: ExtensionHandler<ContextEvent, ContextEventResult> | undefined;
	const api = {
		on: (event: string, handler: ExtensionHandler<ContextEvent, ContextEventResult>) => {
			if (event === "context") contextHandler = handler;
		},
	} as ExtensionAPI;
	compactionExtension(api);
	expect(contextHandler).toBeDefined();
	return contextHandler as ExtensionHandler<ContextEvent, ContextEventResult>;
}

function createBeforeAgentStartHandler(): ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult> {
	let beforeAgentStartHandler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult> | undefined;
	const api = {
		on: (event: string, handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>) => {
			if (event === "before_agent_start") beforeAgentStartHandler = handler;
		},
	} as ExtensionAPI;
	compactionExtension(api);
	expect(beforeAgentStartHandler).toBeDefined();
	return beforeAgentStartHandler as ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>;
}

function createContext(contextWindow: number, maxTokens = contextWindow, compact = vi.fn()): ExtensionContext {
	const sessionManager = Object.create(null) as ExtensionContext["sessionManager"];
	sessionManager.getBranch = vi.fn(() => []);
	return {
		hasUI: false,
		mode: "print",
		ui: Object.create(null) as ExtensionContext["ui"],
		cwd: process.cwd(),
		isProjectTrusted: () => true,
		sessionManager,
		modelRegistry: {} as ExtensionContext["modelRegistry"],
		model: { contextWindow, maxTokens } as ExtensionContext["model"],
		serviceTier: undefined,
		isIdle: () => true,
		signal: undefined,
		abort: vi.fn(),
		hasPendingMessages: () => false,
		shutdown: vi.fn(),
		getContextUsage: () => ({ tokens: contextWindow + 1, contextWindow, percent: 1.01 }),
		getCompactionSettings: () => ({ enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 }),
		compact,
		getMessageRevision: () => 0,
		applyCompaction: async () => ({ applied: false, reason: "rejected" }),
		getSystemPrompt: () => "",
	} as ExtensionContext;
}

function createCompactionContext(): ExtensionContext {
	const registration = registerFauxProvider();
	registrations.push(registration);
	registration.setResponses([fauxAssistantMessage("## Goal\nEmergency summary")]);
	const model = registration.getModel();
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendMessage(userMessage("Summarize old context", 1));
	sessionManager.appendMessage({
		...fauxAssistantMessage("Old assistant context ".repeat(6_000), { timestamp: 2 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 30_000,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 30_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	sessionManager.appendMessage(userMessage("Keep latest request", 3));
	const modelRegistry = Object.create(null) as ExtensionContext["modelRegistry"];
	modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test-key" });
	const applyCompaction = vi.fn(async () => ({ applied: true as const, reason: "ok" as const }));
	return {
		hasUI: false,
		mode: "print",
		ui: Object.create(null) as ExtensionContext["ui"],
		cwd: process.cwd(),
		isProjectTrusted: () => true,
		sessionManager,
		modelRegistry,
		model,
		serviceTier: undefined,
		isIdle: () => true,
		signal: undefined,
		abort: vi.fn(),
		hasPendingMessages: () => false,
		shutdown: vi.fn(),
		getContextUsage: () => ({ tokens: 9_950, contextWindow: 10_000, percent: 99.5 }),
		getCompactionSettings: () => ({ enabled: true, reserveTokens: 100, keepRecentTokens: 2_000 }),
		compact: vi.fn(),
		getMessageRevision: () => 1,
		applyCompaction,
		getSystemPrompt: () => "",
	};
}

function collectToolPairIds(messages: AgentMessage[]): { toolCallIds: Set<string>; toolResultIds: Set<string> } {
	const toolCallIds = new Set<string>();
	const toolResultIds = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") toolCallIds.add(block.id);
			}
		}
		if (message.role === "toolResult") toolResultIds.add(message.toolCallId);
	}
	return { toolCallIds, toolResultIds };
}

describe("compaction hard-limit emergency behavior", () => {
	describe("Given hard-limit context can fit after tool-output truncation", () => {
		describe("When context hook runs", () => {
			it("Then no LLM compaction is requested and tool pairs remain intact", async () => {
				// Given
				const handler = createContextHandler();
				const compact = vi.fn();
				const messages: AgentMessage[] = [
					userMessage("Run a command", 1),
					assistantWithToolCall("call-1", "produce output", 2),
					toolResult("call-1", "A".repeat(20_000), 3),
					userMessage("Continue from this result", 4),
				];

				// When
				const result = await handler({ type: "context", messages }, createContext(2_000, 2_000, compact));
				const pruned = result?.messages ?? messages;

				// Then
				expect(estimateContextTokens(pruned).tokens).toBeLessThanOrEqual(2_000);
				expect(compact).not.toHaveBeenCalled();
				const { toolCallIds, toolResultIds } = collectToolPairIds(pruned);
				expect(toolCallIds).toEqual(toolResultIds);
			});
		});
	});

	describe("Given hard-limit context still exceeds the window after tool-output truncation", () => {
		describe("When context hook runs", () => {
			it("Then whole old tool pairs are pruned before the provider request", async () => {
				// Given
				const handler = createContextHandler();
				const compact = vi.fn();
				const lastUser = userMessage("Keep this exact latest request", 8);
				const messages: AgentMessage[] = [
					userMessage("Old setup", 1),
					assistantWithToolCall("call-1", "large old command", 2),
					toolResult("call-1", "A".repeat(80_000), 3),
					userMessage("Old follow-up", 4),
					assistantWithToolCall("call-2", "another large command", 5),
					toolResult("call-2", "B".repeat(80_000), 6),
					lastUser,
				];

				const context = createContext(20, 20, compact);

				// When
				const result = await handler({ type: "context", messages }, context);
				const pruned = result?.messages ?? messages;

				// Then
				expect(estimateContextTokens(pruned).tokens).toBeLessThanOrEqual(20);
				expect(pruned).toContainEqual(lastUser);
				expect(pruned).not.toContainEqual(messages[1]);
				expect(pruned).not.toContainEqual(messages[2]);
				const { toolCallIds, toolResultIds } = collectToolPairIds(pruned);
				expect(toolCallIds).toEqual(toolResultIds);
			});
		});
	});

	describe("Given model output tokens consume part of the context window", () => {
		describe("When context hook runs with an oversized paired tool result", () => {
			it("Then it reserves valid model output budget and preserves the latest user and tool pair", async () => {
				// Given
				const handler = createContextHandler();
				const lastUser = userMessage("Keep this latest request", 4);
				const messages: AgentMessage[] = [
					userMessage("Run a command", 1),
					assistantWithToolCall("call-large", "produce large output", 2),
					toolResult("call-large", "A".repeat(1_000_000), 3),
					lastUser,
				];
				const maximumInputTokens = Math.floor((372_000 - 128_000) * 0.95);

				// When
				const result = await handler({ type: "context", messages }, createContext(372_000, 128_000));
				const pruned = result?.messages ?? messages;

				// Then
				expect(estimateContextTokens(pruned).tokens).toBeLessThanOrEqual(maximumInputTokens);
				expect(pruned).toContainEqual(lastUser);
				const { toolCallIds, toolResultIds } = collectToolPairIds(pruned);
				expect(toolCallIds).toEqual(toolResultIds);
			});
		});
	});

	describe("Given model output tokens equal the context window", () => {
		describe("When context hook runs with a small paired tool result", () => {
			it("Then it leaves the paired result byte-for-byte unchanged", async () => {
				// Given
				const handler = createContextHandler();
				const messages: AgentMessage[] = [
					userMessage("Run a small command", 1),
					assistantWithToolCall("call-small", "printf small", 2),
					toolResult("call-small", "small result\n", 3),
					userMessage("Use the small result", 4),
				];
				const originalBytes = JSON.stringify(messages);

				// When
				const result = await handler({ type: "context", messages }, createContext(372_000, 372_000));
				const pruned = result?.messages ?? messages;

				// Then
				expect(JSON.stringify(pruned)).toBe(originalBytes);
			});
		});
	});

	describe("Given usage is at the hard limit before the next agent turn", () => {
		describe("When before_agent_start runs", () => {
			it("Then aggressive extension compaction is applied once before normal threshold compaction", async () => {
				// Given
				const beforeAgentStartHandler = createBeforeAgentStartHandler();
				const context = createCompactionContext();
				const event: BeforeAgentStartEvent = {
					type: "before_agent_start",
					prompt: "continue",
					systemPrompt: "system",
					systemPromptOptions: Object.create(null) as BeforeAgentStartEvent["systemPromptOptions"],
				};

				// When
				await beforeAgentStartHandler(event, context);

				// Then
				expect(context.compact).not.toHaveBeenCalled();
				expect(context.applyCompaction).toHaveBeenCalledTimes(1);
				expect(context.applyCompaction).toHaveBeenCalledWith(
					expect.objectContaining({
						summary: "## Goal\nEmergency summary",
					}),
					expect.objectContaining({ reason: "extension", expectedRevision: 1 }),
				);
			});
		});
	});
});
