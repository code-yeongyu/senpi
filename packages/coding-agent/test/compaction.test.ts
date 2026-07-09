import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context, Model, StreamOptions, Usage } from "@earendil-works/pi-ai/compat";
import { readFileSync } from "fs";
import { join } from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { completeMock } = vi.hoisted(() => ({
	completeMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
	return {
		...actual,
		complete: completeMock,
		stream: (model: Model<string>, context: Context, options: StreamOptions) => {
			const output = actual.createAssistantMessageEventStream();
			queueMicrotask(async () => {
				const message = (await completeMock(model, context, options)) as AssistantMessage;
				if (message.stopReason === "error" || message.stopReason === "aborted") {
					output.push({ type: "error", reason: message.stopReason, error: message });
				} else {
					output.push({ type: "done", reason: message.stopReason, message });
				}
				output.end(message);
			});
			return output;
		},
	};
});

import {
	type CompactionSettings,
	calculateContextTokens,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	findCutPoint,
	getLastAssistantUsage,
	prepareCompaction,
	shouldCompact,
} from "../src/core/compaction/index.ts";
import compactionExtension from "../src/core/extensions/builtin/compaction/index.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	MessageEndEvent,
	ModelSelectEvent,
} from "../src/core/extensions/index.ts";
import {
	buildSessionContext,
	type CompactionEntry,
	type CustomMessageEntry,
	type ModelChangeEntry,
	migrateSessionEntries,
	parseSessionEntries,
	type SessionEntry,
	type SessionMessageEntry,
	type ThinkingLevelChangeEntry,
} from "../src/core/session-manager.ts";

// ============================================================================
// Test fixtures
// ============================================================================

function loadLargeSessionEntries(): SessionEntry[] {
	const sessionPath = join(__dirname, "fixtures/large-session.jsonl");
	const content = readFileSync(sessionPath, "utf-8");
	const entries = parseSessionEntries(content);
	migrateSessionEntries(entries); // Add id/parentId for v1 fixtures
	return entries.filter((e): e is SessionEntry => e.type !== "session");
}

function createMockUsage(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createUserMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function createAssistantMessage(text: string, usage?: Usage): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: usage || createMockUsage(100, 50),
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	};
}

let entryCounter = 0;
let lastId: string | null = null;

function resetEntryCounter() {
	entryCounter = 0;
	lastId = null;
}

// Reset counter before each test to get predictable IDs
beforeEach(() => {
	resetEntryCounter();
	completeMock.mockReset();
	completeMock.mockResolvedValue({
		role: "assistant",
		content: [{ type: "text", text: "<summary>locked summary</summary>" }],
	});
});

function createMessageEntry(message: AgentMessage): SessionMessageEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: SessionMessageEntry = {
		type: "message",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		message,
	};
	lastId = id;
	return entry;
}

function createCompactionEntry(summary: string, firstKeptEntryId: string): CompactionEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: CompactionEntry = {
		type: "compaction",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId,
		tokensBefore: 10000,
	};
	lastId = id;
	return entry;
}

function createModelChangeEntry(provider: string, modelId: string): ModelChangeEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: ModelChangeEntry = {
		type: "model_change",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		provider,
		modelId,
	};
	lastId = id;
	return entry;
}

function createThinkingLevelEntry(thinkingLevel: string): ThinkingLevelChangeEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: ThinkingLevelChangeEntry = {
		type: "thinking_level_change",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		thinkingLevel,
	};
	lastId = id;
	return entry;
}

function createCustomMessageEntry(content: string): CustomMessageEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: CustomMessageEntry = {
		type: "custom_message",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		customType: "test",
		content,
		display: true,
	};
	lastId = id;
	return entry;
}

type BeforeAgentStartHandler = (
	event: { type: "before_agent_start"; systemPrompt: string },
	ctx: ExtensionContext,
) => Promise<{ systemPrompt?: string } | undefined> | { systemPrompt?: string } | undefined;
type ModelSelectHandler = (event: ModelSelectEvent, ctx: ExtensionContext) => Promise<unknown> | unknown;
type MessageEndHandler = (event: MessageEndEvent, ctx: ExtensionContext) => Promise<unknown> | unknown;
interface CapturedCompactionHandlers {
	beforeAgentStart: BeforeAgentStartHandler;
	messageEnd: MessageEndHandler;
	modelSelect: ModelSelectHandler;
}

function captureBeforeAgentStartHandler(): BeforeAgentStartHandler {
	let handler: BeforeAgentStartHandler | undefined;
	const api: ExtensionAPI = Object.assign(Object.create(null), {
		on: (event: string, currentHandler: BeforeAgentStartHandler) => {
			if (event === "before_agent_start") {
				handler = currentHandler;
			}
		},
		appendEntry: vi.fn(),
		getActiveTools: () => [],
		getThinkingLevel: () => "off" as const,
	});

	compactionExtension(api);
	if (!handler) {
		throw new Error("before_agent_start handler was not registered");
	}
	return handler;
}

function captureCompactionHandlers(): CapturedCompactionHandlers {
	let beforeAgentStart: BeforeAgentStartHandler | undefined;
	let messageEnd: MessageEndHandler | undefined;
	let modelSelect: ModelSelectHandler | undefined;
	const api: ExtensionAPI = Object.assign(Object.create(null), {
		on: (event: string, currentHandler: BeforeAgentStartHandler | MessageEndHandler | ModelSelectHandler) => {
			if (event === "before_agent_start") {
				beforeAgentStart = currentHandler as BeforeAgentStartHandler;
			} else if (event === "message_end") {
				messageEnd = currentHandler as MessageEndHandler;
			} else if (event === "model_select") {
				modelSelect = currentHandler as ModelSelectHandler;
			}
		},
		appendEntry: vi.fn(),
		events: { emit: vi.fn() },
		getActiveTools: () => [],
		getThinkingLevel: () => "off" as const,
	});

	compactionExtension(api);
	if (!beforeAgentStart || !messageEnd || !modelSelect) {
		throw new Error("builtin compaction handlers were not registered");
	}
	return { beforeAgentStart, messageEnd, modelSelect };
}

function createExtensionContext(overrides: Partial<ExtensionContext>): ExtensionContext {
	return {
		hasUI: false,
		mode: "print",
		ui: {} as ExtensionContext["ui"],
		cwd: process.cwd(),
		isProjectTrusted: () => true,
		sessionManager: Object.assign(Object.create(null), {
			getEntries: () => [],
		}) as ExtensionContext["sessionManager"],
		modelRegistry: {} as ExtensionContext["modelRegistry"],
		model: undefined,
		serviceTier: undefined,
		isIdle: () => true,
		signal: undefined,
		abort: vi.fn(),
		hasPendingMessages: () => false,
		shutdown: vi.fn(),
		getContextUsage: () => undefined,
		getCompactionSettings: () => DEFAULT_COMPACTION_SETTINGS,
		compact: vi.fn(),
		getMessageRevision: () => 0,
		applyCompaction: async () => ({ applied: false, reason: "rejected" }),
		beginCompaction: () => undefined,
		endCompaction: vi.fn(),
		getSystemPrompt: () => "",
		...overrides,
	};
}

function createAnthropicModel(id: string, contextWindow: number): Model<"anthropic-messages"> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 8192,
	};
}

async function expectSpeculativeCompactionInvalidatedBy(
	trigger: (
		handlers: CapturedCompactionHandlers,
		ctx: ExtensionContext,
		previousModel: Model<"anthropic-messages">,
		nextModel: Model<"anthropic-messages">,
	) => Promise<void> | void,
): Promise<void> {
	const handlers = captureCompactionHandlers();
	const previousModel = createAnthropicModel("claude-small", 200_000);
	const nextModel = createAnthropicModel("claude-large", 800_000);
	const firstUser = createMessageEntry(createUserMessage("first request"));
	const firstAssistant = createMessageEntry(createAssistantMessage("first answer", createMockUsage(4000, 500)));
	const secondUser = createMessageEntry(createUserMessage("second request"));
	const secondAssistant = createMessageEntry(createAssistantMessage("second answer", createMockUsage(5000, 500)));
	const branchEntries = [firstUser, firstAssistant, secondUser, secondAssistant];
	const appliedSummaries: string[] = [];
	let currentModel = previousModel;
	let usageTokens = 100_000;
	let releaseStale: (() => void) | undefined;
	const speculativeStarted = new Promise<void>((resolveStarted) => {
		completeMock.mockImplementationOnce(async (_model: Model<string>, _context: Context, options: StreamOptions) => {
			return await new Promise<AssistantMessage>((resolve) => {
				releaseStale = () => resolve(createAssistantMessage("stale summary"));
				options.signal?.addEventListener(
					"abort",
					() => {
						resolve({ ...createAssistantMessage(""), stopReason: "aborted" });
					},
					{ once: true },
				);
				resolveStarted();
			});
		});
	});
	completeMock.mockResolvedValueOnce(createAssistantMessage("fresh summary"));
	const ctx = createExtensionContext({
		model: currentModel,
		sessionManager: Object.assign(Object.create(null), {
			getEntries: () => branchEntries,
			getBranch: () => branchEntries,
		}) as ExtensionContext["sessionManager"],
		modelRegistry: Object.assign(Object.create(null), {
			getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key" }),
		}) as ExtensionContext["modelRegistry"],
		applyCompaction: async (compaction) => {
			appliedSummaries.push(compaction.summary);
			return { applied: true, reason: "ok" };
		},
		getContextUsage: () => ({
			tokens: usageTokens,
			contextWindow: currentModel.contextWindow,
			percent: (usageTokens / currentModel.contextWindow) * 100,
		}),
		getCompactionSettings: () => ({ ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 }),
	});

	// given
	await handlers.beforeAgentStart({ type: "before_agent_start", systemPrompt: "system" }, ctx);
	await speculativeStarted;

	// when
	currentModel = nextModel;
	ctx.model = nextModel;
	await trigger(handlers, ctx, previousModel, nextModel);
	releaseStale?.();
	usageTokens = 790_000;
	await handlers.beforeAgentStart({ type: "before_agent_start", systemPrompt: "system" }, ctx);

	// then
	expect(appliedSummaries).toEqual(["fresh summary"]);
}

function extractText(messages: AgentMessage[]): string {
	return messages
		.map((message) => {
			switch (message.role) {
				case "user":
					return typeof message.content === "string"
						? message.content
						: message.content
								.filter((block): block is { type: "text"; text: string } => block.type === "text")
								.map((block) => block.text)
								.join(" ");
				case "assistant":
					return message.content
						.filter((block): block is { type: "text"; text: string } => block.type === "text")
						.map((block) => block.text)
						.join(" ");
				case "branchSummary":
				case "compactionSummary":
					return message.summary;
				case "custom":
				case "toolResult":
					return typeof message.content === "string"
						? message.content
						: message.content
								.filter((block): block is { type: "text"; text: string } => block.type === "text")
								.map((block) => block.text)
								.join(" ");
				case "bashExecution":
					return `${message.command}\n${message.output}`;
				default:
					return "";
			}
		})
		.join("\n");
}

// ============================================================================
// Unit tests
// ============================================================================

describe("Token calculation", () => {
	it("should calculate total context tokens from usage", () => {
		const usage = createMockUsage(1000, 500, 200, 100);
		expect(calculateContextTokens(usage)).toBe(1800);
	});

	it("should handle zero values", () => {
		const usage = createMockUsage(0, 0, 0, 0);
		expect(calculateContextTokens(usage)).toBe(0);
	});
});

describe("getLastAssistantUsage", () => {
	it("should find the last non-aborted assistant message usage", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Hello")),
			createMessageEntry(createAssistantMessage("Hi", createMockUsage(100, 50))),
			createMessageEntry(createUserMessage("How are you?")),
			createMessageEntry(createAssistantMessage("Good", createMockUsage(200, 100))),
		];

		const usage = getLastAssistantUsage(entries);
		expect(usage).not.toBeNull();
		expect(usage!.input).toBe(200);
	});

	it("should skip aborted messages", () => {
		const abortedMsg: AssistantMessage = {
			...createAssistantMessage("Aborted", createMockUsage(300, 150)),
			stopReason: "aborted",
		};

		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Hello")),
			createMessageEntry(createAssistantMessage("Hi", createMockUsage(100, 50))),
			createMessageEntry(createUserMessage("How are you?")),
			createMessageEntry(abortedMsg),
		];

		const usage = getLastAssistantUsage(entries);
		expect(usage).not.toBeNull();
		expect(usage!.input).toBe(100);
	});

	it("should skip all-zero assistant usage", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Hello")),
			createMessageEntry(createAssistantMessage("Hi", createMockUsage(100, 50))),
			createMessageEntry(createUserMessage("continue")),
			createMessageEntry(createAssistantMessage("Partial", createMockUsage(0, 0))),
		];

		const usage = getLastAssistantUsage(entries);
		expect(usage).not.toBeNull();
		expect(usage!.input).toBe(100);
	});

	it("should return undefined if no assistant messages", () => {
		const entries: SessionEntry[] = [createMessageEntry(createUserMessage("Hello"))];
		expect(getLastAssistantUsage(entries)).toBeUndefined();
	});
});

describe("estimateContextTokens", () => {
	it("uses the last non-zero assistant usage as the context anchor", () => {
		const messages: AgentMessage[] = [
			createUserMessage("Hello"),
			createAssistantMessage("Hi", createMockUsage(100, 50)),
			createUserMessage("continue"),
			createAssistantMessage("Partial thinking", createMockUsage(0, 0)),
		];

		const estimate = estimateContextTokens(messages);

		expect(estimate.usageTokens).toBe(150);
		expect(estimate.lastUsageIndex).toBe(1);
		expect(estimate.trailingTokens).toBeGreaterThan(0);
		expect(estimate.tokens).toBe(150 + estimate.trailingTokens);
	});
});

describe("shouldCompact", () => {
	it("should return true when context exceeds threshold", () => {
		const settings: CompactionSettings = {
			enabled: true,
			reserveTokens: 10000,
			keepRecentTokens: 20000,
		};

		expect(shouldCompact(95000, 100000, settings)).toBe(true);
		expect(shouldCompact(89000, 100000, settings)).toBe(false);
	});

	it("should return false when disabled", () => {
		const settings: CompactionSettings = {
			enabled: false,
			reserveTokens: 10000,
			keepRecentTokens: 20000,
		};

		expect(shouldCompact(95000, 100000, settings)).toBe(false);
	});
});

describe("findCutPoint", () => {
	it("should find cut point based on actual token differences", () => {
		// Create entries with cumulative token counts
		const entries: SessionEntry[] = [];
		for (let i = 0; i < 10; i++) {
			entries.push(createMessageEntry(createUserMessage(`User ${i}`)));
			entries.push(
				createMessageEntry(createAssistantMessage(`Assistant ${i}`, createMockUsage(0, 100, (i + 1) * 1000, 0))),
			);
		}

		// 20 entries, last assistant has 10000 tokens
		// keepRecentTokens = 2500: keep entries where diff < 2500
		const result = findCutPoint(entries, 0, entries.length, 2500);

		// Should cut at a valid cut point (user or assistant message)
		expect(entries[result.firstKeptEntryIndex].type).toBe("message");
		const role = (entries[result.firstKeptEntryIndex] as SessionMessageEntry).message.role;
		expect(role === "user" || role === "assistant").toBe(true);
	});

	it("should return startIndex if no valid cut points in range", () => {
		const entries: SessionEntry[] = [createMessageEntry(createAssistantMessage("a"))];
		const result = findCutPoint(entries, 0, entries.length, 1000);
		expect(result.firstKeptEntryIndex).toBe(0);
	});

	it("should keep everything if all messages fit within budget", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("1")),
			createMessageEntry(createAssistantMessage("a", createMockUsage(0, 50, 500, 0))),
			createMessageEntry(createUserMessage("2")),
			createMessageEntry(createAssistantMessage("b", createMockUsage(0, 50, 1000, 0))),
		];

		const result = findCutPoint(entries, 0, entries.length, 50000);
		expect(result.firstKeptEntryIndex).toBe(0);
	});

	it("should indicate split turn when cutting at assistant message", () => {
		// Create a scenario where we cut at an assistant message mid-turn
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Turn 1")),
			createMessageEntry(createAssistantMessage("A1", createMockUsage(0, 100, 1000, 0))),
			createMessageEntry(createUserMessage("Turn 2")), // index 2
			createMessageEntry(createAssistantMessage("A2-1", createMockUsage(0, 100, 5000, 0))), // index 3
			createMessageEntry(createAssistantMessage("A2-2", createMockUsage(0, 100, 8000, 0))), // index 4
			createMessageEntry(createAssistantMessage("A2-3", createMockUsage(0, 100, 10000, 0))), // index 5
		];

		// With keepRecentTokens = 3000, should cut somewhere in Turn 2
		const result = findCutPoint(entries, 0, entries.length, 3000);

		// If cut at assistant message (not user), should indicate split turn
		const cutEntry = entries[result.firstKeptEntryIndex] as SessionMessageEntry;
		if (cutEntry.message.role === "assistant") {
			expect(result.isSplitTurn).toBe(true);
			expect(result.turnStartIndex).toBe(2); // Turn 2 starts at index 2
		}
	});

	it("falls back to the last valid cut point when the budget is exceeded beyond it", () => {
		const tinyBudget = 100;
		const toolResultExceedingBudgetAlone = "x".repeat(8000);
		const lastValidCutPointIndex = 1;
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("u")),
			createMessageEntry(createAssistantMessage("a", createMockUsage(0, 50, 500, 0))),
			createMessageEntry({
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: toolResultExceedingBudgetAlone }],
				isError: false,
				timestamp: Date.now(),
			}),
			createMessageEntry({
				role: "toolResult",
				toolCallId: "call-2",
				toolName: "read",
				content: [{ type: "text", text: toolResultExceedingBudgetAlone }],
				isError: false,
				timestamp: Date.now(),
			}),
		];

		const result = findCutPoint(entries, 0, entries.length, tinyBudget);

		expect(result.firstKeptEntryIndex).toBe(lastValidCutPointIndex);
	});

	it("should budget context-visible custom message entries", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("hi")),
			createMessageEntry(createAssistantMessage("hello")),
			createCustomMessageEntry("x".repeat(4000)),
			createMessageEntry(createAssistantMessage("ok")),
		];

		const tinyBudget = findCutPoint(entries, 0, entries.length, 1);
		expect(tinyBudget.firstKeptEntryIndex).toBe(3);
		expect(tinyBudget.isSplitTurn).toBe(true);
		expect(tinyBudget.turnStartIndex).toBe(2);

		const customFitsBudget = findCutPoint(entries, 0, entries.length, 2);
		expect(customFitsBudget.firstKeptEntryIndex).toBe(2);
		expect(customFitsBudget.isSplitTurn).toBe(false);
		expect(customFitsBudget.turnStartIndex).toBe(-1);
	});
});

describe("buildSessionContext", () => {
	it("should load all messages when no compaction", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("1")),
			createMessageEntry(createAssistantMessage("a")),
			createMessageEntry(createUserMessage("2")),
			createMessageEntry(createAssistantMessage("b")),
		];

		const loaded = buildSessionContext(entries);
		expect(loaded.messages.length).toBe(4);
		expect(loaded.thinkingLevel).toBe("off");
		expect(loaded.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
	});

	it("should handle single compaction", () => {
		// IDs: u1=test-id-0, a1=test-id-1, u2=test-id-2, a2=test-id-3, compaction=test-id-4, u3=test-id-5, a3=test-id-6
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"));
		const u2 = createMessageEntry(createUserMessage("2"));
		const a2 = createMessageEntry(createAssistantMessage("b"));
		const compaction = createCompactionEntry("Summary of 1,a,2,b", u2.id); // keep from u2 onwards
		const u3 = createMessageEntry(createUserMessage("3"));
		const a3 = createMessageEntry(createAssistantMessage("c"));

		const entries: SessionEntry[] = [u1, a1, u2, a2, compaction, u3, a3];

		const loaded = buildSessionContext(entries);
		// summary + kept (u2, a2) + after (u3, a3) = 5
		expect(loaded.messages.length).toBe(5);
		const summaryMessage = loaded.messages[0];
		if (summaryMessage.role !== "compactionSummary") {
			throw new Error("Expected first message to be a compaction summary");
		}
		expect(summaryMessage.summary).toContain("Summary of 1,a,2,b");
	});

	it("should handle multiple compactions (only latest matters)", () => {
		// First batch
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"));
		const compact1 = createCompactionEntry("First summary", u1.id);
		// Second batch
		const u2 = createMessageEntry(createUserMessage("2"));
		const b = createMessageEntry(createAssistantMessage("b"));
		const u3 = createMessageEntry(createUserMessage("3"));
		const c = createMessageEntry(createAssistantMessage("c"));
		const compact2 = createCompactionEntry("Second summary", u3.id); // keep from u3 onwards
		// After second compaction
		const u4 = createMessageEntry(createUserMessage("4"));
		const d = createMessageEntry(createAssistantMessage("d"));

		const entries: SessionEntry[] = [u1, a1, compact1, u2, b, u3, c, compact2, u4, d];

		const loaded = buildSessionContext(entries);
		// summary + kept from u3 (u3, c) + after (u4, d) = 5
		expect(loaded.messages.length).toBe(5);
		const summaryMessage = loaded.messages[0];
		if (summaryMessage.role !== "compactionSummary") {
			throw new Error("Expected first message to be a compaction summary");
		}
		expect(summaryMessage.summary).toContain("Second summary");
	});

	it("should keep all messages when firstKeptEntryId is first entry", () => {
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"));
		const compact1 = createCompactionEntry("First summary", u1.id); // keep from first entry
		const u2 = createMessageEntry(createUserMessage("2"));
		const b = createMessageEntry(createAssistantMessage("b"));

		const entries: SessionEntry[] = [u1, a1, compact1, u2, b];

		const loaded = buildSessionContext(entries);
		// summary + all messages (u1, a1, u2, b) = 5
		expect(loaded.messages.length).toBe(5);
	});

	it("should track model and thinking level changes", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("1")),
			createModelChangeEntry("openai", "gpt-4"),
			createMessageEntry(createAssistantMessage("a")),
			createThinkingLevelEntry("high"),
		];

		const loaded = buildSessionContext(entries);
		// model_change is later overwritten by assistant message's model info
		expect(loaded.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
		expect(loaded.thinkingLevel).toBe("high");
	});
});

describe("prepareCompaction with previous compaction", () => {
	it("returns undefined for a repeated compaction whose kept messages still fit within keepRecentTokens", () => {
		// given
		const u1 = createMessageEntry(createUserMessage("user msg 1 (summarized by compaction1)"));
		const a1 = createMessageEntry(createAssistantMessage("assistant msg 1"));
		const u2 = createMessageEntry(createUserMessage("user msg 2 - kept by compaction1"));
		const a2 = createMessageEntry(createAssistantMessage("assistant msg 2"));
		const u3 = createMessageEntry(createUserMessage("user msg 3 - kept by compaction1"));
		const a3 = createMessageEntry(createAssistantMessage("assistant msg 3", createMockUsage(5000, 1000)));
		const compaction1 = createCompactionEntry("First summary", u2.id);
		const u4 = createMessageEntry(createUserMessage("user msg 4 (new after compaction1)"));
		const a4 = createMessageEntry(createAssistantMessage("assistant msg 4", createMockUsage(8000, 2000)));

		const pathEntries = [u1, a1, u2, a2, u3, a3, compaction1, u4, a4];

		// when
		const preparation = prepareCompaction(pathEntries, DEFAULT_COMPACTION_SETTINGS);

		// then
		expect(preparation).toBeUndefined();
		const contextText = extractText(buildSessionContext(pathEntries).messages);
		expect(contextText).toContain("user msg 2 - kept by compaction1");
		expect(contextText).toContain("user msg 3 - kept by compaction1");
		expect(contextText).toContain("user msg 4 (new after compaction1)");
	});

	it("should re-summarize previously kept messages when the recent window moves past them", () => {
		const u1 = createMessageEntry(createUserMessage("user msg 1 (summarized by compaction1)".repeat(4)));
		const a1 = createMessageEntry(createAssistantMessage("assistant msg 1".repeat(4)));
		const u2 = createMessageEntry(createUserMessage("user msg 2 - kept by compaction1 ".repeat(12)));
		const a2 = createMessageEntry(createAssistantMessage("assistant msg 2 ".repeat(12)));
		const u3 = createMessageEntry(createUserMessage("user msg 3 - kept by compaction1 ".repeat(12)));
		const a3 = createMessageEntry(createAssistantMessage("assistant msg 3 ".repeat(12), createMockUsage(5000, 1000)));
		const compaction1 = createCompactionEntry("First summary", u2.id);
		const u4 = createMessageEntry(createUserMessage("user msg 4 (new after compaction1) ".repeat(12)));
		const a4 = createMessageEntry(createAssistantMessage("assistant msg 4 ".repeat(12), createMockUsage(8000, 2000)));

		const settings: CompactionSettings = {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 100,
		};
		const preparation = prepareCompaction([u1, a1, u2, a2, u3, a3, compaction1, u4, a4], settings);

		expect(preparation).toBeDefined();
		const summarizedText = extractText(preparation!.messagesToSummarize);
		expect(summarizedText).toContain("user msg 2 - kept by compaction1");
		expect(summarizedText).toContain("user msg 3 - kept by compaction1");
		expect(summarizedText).not.toContain("First summary");
		expect(preparation!.previousSummary).toBe("First summary");
	});
});

describe("prepareCompaction guards against empty summarization", () => {
	it("returns undefined for a tiny senpi-style hello session whose entire history fits in keepRecentTokens", () => {
		// given
		const modelChange = createModelChangeEntry("apitopia", "kimi-k2p6-turbo");
		const thinkingChange = createThinkingLevelEntry("minimal");
		const u1 = createMessageEntry(createUserMessage("hi"));
		const a1 = createMessageEntry(createAssistantMessage("Hello! How can I help you today?"));
		const u2 = createMessageEntry(createUserMessage("who are you"));
		const a2 = createMessageEntry(createAssistantMessage("I'm Kimi, an AI assistant created by Moonshot AI."));

		// when
		const preparation = prepareCompaction([modelChange, thinkingChange, u1, a1, u2, a2], DEFAULT_COMPACTION_SETTINGS);

		// then
		expect(preparation).toBeUndefined();
	});

	it("returns undefined when only non-message entries precede the kept window", () => {
		// given
		const modelChange = createModelChangeEntry("anthropic", "claude-sonnet-4-5");
		const thinkingChange = createThinkingLevelEntry("medium");
		const u1 = createMessageEntry(createUserMessage("first message"));
		const settings: CompactionSettings = {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 10000,
		};

		// when
		const preparation = prepareCompaction([modelChange, thinkingChange, u1], settings);

		// then
		expect(preparation).toBeUndefined();
	});

	it("still returns a preparation when the session is large enough to actually summarize", () => {
		// given
		const u1 = createMessageEntry(createUserMessage("first user message".repeat(20)));
		const a1 = createMessageEntry(createAssistantMessage("first assistant".repeat(20), createMockUsage(2000, 500)));
		const u2 = createMessageEntry(createUserMessage("second user message".repeat(20)));
		const a2 = createMessageEntry(createAssistantMessage("second assistant".repeat(20), createMockUsage(3000, 800)));
		const settings: CompactionSettings = {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 80,
		};

		// when
		const preparation = prepareCompaction([u1, a1, u2, a2], settings);

		// then
		expect(preparation).toBeDefined();
		expect(preparation!.messagesToSummarize.length).toBeGreaterThan(0);
	});
});

describe("builtin compaction extension threshold regressions", () => {
	it("does not trigger proactive compaction when resolved user settings disable compaction", async () => {
		// given
		const handler = captureBeforeAgentStartHandler();
		const compact = vi.fn();
		const ctx = createExtensionContext({
			getContextUsage: () => ({ tokens: 190_000, contextWindow: 200_000, percent: 0.95 }),
			getCompactionSettings: () => ({ ...DEFAULT_COMPACTION_SETTINGS, enabled: false }),
			compact,
		});

		// when
		await handler({ type: "before_agent_start", systemPrompt: "system" }, ctx);

		// then
		expect(compact).not.toHaveBeenCalled();
	});

	it("synchronously applies compaction via applyCompaction in before_agent_start when above threshold", async () => {
		// given
		const handler = captureBeforeAgentStartHandler();
		const order: string[] = [];
		const model: Model<"anthropic-messages"> = {
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8192,
		};
		const firstUser = createMessageEntry(createUserMessage("first request"));
		const firstAssistant = createMessageEntry(createAssistantMessage("first answer", createMockUsage(4000, 500)));
		const secondUser = createMessageEntry(createUserMessage("second request"));
		const secondAssistant = createMessageEntry(createAssistantMessage("second answer", createMockUsage(5000, 500)));
		const ctx = createExtensionContext({
			model,
			sessionManager: Object.assign(Object.create(null), {
				getEntries: () => [firstUser, firstAssistant, secondUser, secondAssistant],
				getBranch: () => [firstUser, firstAssistant, secondUser, secondAssistant],
			}) as ExtensionContext["sessionManager"],
			modelRegistry: Object.assign(Object.create(null), {
				getApiKeyAndHeaders: async () => {
					order.push("auth-start");
					return { ok: true, apiKey: "test-key" };
				},
			}) as ExtensionContext["modelRegistry"],
			applyCompaction: async () => {
				order.push("apply-called");
				return { applied: true, reason: "ok" };
			},
			getContextUsage: () => ({ tokens: 190_000, contextWindow: 200_000, percent: 0.95 }),
			getCompactionSettings: () => ({ ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 }),
		});

		// when
		await handler({ type: "before_agent_start", systemPrompt: "system" }, ctx);
		order.push("hook-returned");

		// then
		expect(order).toEqual(["auth-start", "apply-called", "hook-returned"]);
	});

	it("starts compaction feedback before blocking extension summary generation", async () => {
		// given
		const handler = captureBeforeAgentStartHandler();
		const order: string[] = [];
		const controller = new AbortController();
		const model: Model<"anthropic-messages"> = {
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8192,
		};
		const firstUser = createMessageEntry(createUserMessage("first request"));
		const firstAssistant = createMessageEntry(createAssistantMessage("first answer", createMockUsage(4000, 500)));
		const secondUser = createMessageEntry(createUserMessage("second request"));
		const secondAssistant = createMessageEntry(createAssistantMessage("second answer", createMockUsage(5000, 500)));
		const ctx = createExtensionContext({
			model,
			sessionManager: Object.assign(Object.create(null), {
				getEntries: () => [firstUser, firstAssistant, secondUser, secondAssistant],
				getBranch: () => [firstUser, firstAssistant, secondUser, secondAssistant],
			}) as ExtensionContext["sessionManager"],
			modelRegistry: Object.assign(Object.create(null), {
				getApiKeyAndHeaders: async () => {
					order.push("auth-start");
					return { ok: true, apiKey: "test-key" };
				},
			}) as ExtensionContext["modelRegistry"],
			beginCompaction: (options) => {
				order.push(`begin-${options.reason}`);
				return controller.signal;
			},
			applyCompaction: async () => {
				order.push("apply-called");
				return { applied: true, reason: "ok" };
			},
			endCompaction: () => {
				order.push("end-called");
			},
			getContextUsage: () => ({ tokens: 190_000, contextWindow: 200_000, percent: 0.95 }),
			getCompactionSettings: () => ({ ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 }),
		});

		// when
		await handler({ type: "before_agent_start", systemPrompt: "system" }, ctx);
		order.push("hook-returned");

		// then
		expect(order).toEqual(["begin-extension", "auth-start", "apply-called", "hook-returned"]);
	});

	it("drops speculative compaction when a model switch happens before a blocking compaction route", async () => {
		await expectSpeculativeCompactionInvalidatedBy(async (handlers, ctx, previousModel, nextModel) => {
			// given
			const event: ModelSelectEvent = {
				type: "model_select",
				model: nextModel,
				previousModel,
				source: "set",
				systemPrompt: "system",
				systemPromptOptions: { cwd: process.cwd() },
			};

			// when
			await handlers.modelSelect(event, ctx);
		});
	});

	it("drops speculative compaction when an assistant message is aborted before a blocking compaction route", async () => {
		await expectSpeculativeCompactionInvalidatedBy(async (handlers, ctx) => {
			// given
			const event: MessageEndEvent = {
				type: "message_end",
				message: { ...createAssistantMessage(""), stopReason: "aborted" },
			};

			// when
			await handlers.messageEnd(event, ctx);
		});
	});
});

// ============================================================================
// Integration tests with real session data
// ============================================================================

describe("Large session fixture", () => {
	it("should parse the large session", () => {
		const entries = loadLargeSessionEntries();
		expect(entries.length).toBeGreaterThan(100);

		const messageCount = entries.filter((e) => e.type === "message").length;
		expect(messageCount).toBeGreaterThan(100);
	});

	it("should find cut point in large session", () => {
		const entries = loadLargeSessionEntries();
		const result = findCutPoint(entries, 0, entries.length, DEFAULT_COMPACTION_SETTINGS.keepRecentTokens);

		// Cut point should be at a message entry (user or assistant)
		expect(entries[result.firstKeptEntryIndex].type).toBe("message");
		const role = (entries[result.firstKeptEntryIndex] as SessionMessageEntry).message.role;
		expect(role === "user" || role === "assistant").toBe(true);
	});

	it("should load session correctly", () => {
		const entries = loadLargeSessionEntries();
		const loaded = buildSessionContext(entries);

		expect(loaded.messages.length).toBeGreaterThan(100);
		expect(loaded.model).not.toBeNull();
	});
});

//
// LLM integration tests migrated to test/integration/compaction-real-api.test.ts
