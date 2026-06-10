import { describe, expect, it, vi } from "vitest";
import { type CompactionSettings, DEFAULT_COMPACTION_SETTINGS } from "../../src/core/compaction/index.ts";
import compactionExtension from "../../src/core/extensions/builtin/compaction/index.ts";
import {
	computeRestorationBudget,
	consumePendingPayload,
	createRestorationTrackerState,
	preparePendingPayload,
	trackToolCall,
} from "../../src/core/extensions/builtin/compaction/restoration-tracker.ts";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	SessionCompactEvent,
	ToolCallEvent,
	ToolCallEventResult,
} from "../../src/core/extensions/index.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";

interface RestorationGateHarness {
	toolCall: ExtensionHandler<ToolCallEvent, ToolCallEventResult>;
	sessionCompact: ExtensionHandler<SessionCompactEvent>;
	beforeAgentStart: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>;
}

function createRestorationGateHarness(): RestorationGateHarness {
	let toolCall: ExtensionHandler<ToolCallEvent, ToolCallEventResult> | undefined;
	let sessionCompact: ExtensionHandler<SessionCompactEvent> | undefined;
	let beforeAgentStart: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult> | undefined;
	const api = Object.assign(Object.create(null), {
		on: (event: string, handler: unknown) => {
			if (event === "tool_call") {
				toolCall = handler as ExtensionHandler<ToolCallEvent, ToolCallEventResult>;
			}
			if (event === "session_compact") {
				sessionCompact = handler as ExtensionHandler<SessionCompactEvent>;
			}
			if (event === "before_agent_start") {
				beforeAgentStart = handler as ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>;
			}
		},
		appendEntry: vi.fn(),
		getActiveTools: () => [],
		getThinkingLevel: () => "off" as const,
		events: { emit: vi.fn() },
		sendMessage: vi.fn(),
	}) as ExtensionAPI;

	compactionExtension(api);
	if (!toolCall || !sessionCompact || !beforeAgentStart) {
		throw new Error("Compaction extension did not register expected handlers");
	}
	return { toolCall, sessionCompact, beforeAgentStart };
}

function createGateExtensionContext(settings: CompactionSettings): ExtensionContext {
	const entries: SessionEntry[] = [
		{
			type: "message",
			id: "kept-user",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "continue", timestamp: Date.now() },
		},
	];
	const sessionManager = {
		getEntries: () => entries,
		getBranch: () => entries,
	} as ExtensionContext["sessionManager"];

	return {
		hasUI: false,
		mode: "print",
		ui: Object.assign(Object.create(null), {
			notify: vi.fn(),
		}) as ExtensionContext["ui"],
		cwd: process.cwd(),
		isProjectTrusted: () => true,
		sessionManager,
		modelRegistry: {} as ExtensionContext["modelRegistry"],
		model: undefined,
		serviceTier: undefined,
		isIdle: () => true,
		signal: undefined,
		abort: vi.fn(),
		hasPendingMessages: () => false,
		shutdown: vi.fn(),
		getContextUsage: () => undefined,
		getCompactionSettings: () => settings,
		compact: vi.fn(),
		getMessageRevision: () => 1,
		applyCompaction: async () => ({ applied: false, reason: "rejected" }),
		beginCompaction: () => undefined,
		endCompaction: vi.fn(),
		getSystemPrompt: () => "",
	} as ExtensionContext;
}

function createAcceptedCompactEvent(): SessionCompactEvent {
	return {
		type: "session_compact",
		reason: "manual",
		requestId: "restoration-gate-request",
		accepted: true,
		compactionEntry: {
			type: "compaction",
			id: "compact-gate",
			parentId: "kept-user",
			timestamp: new Date().toISOString(),
			summary: "Compacted context",
			firstKeptEntryId: "kept-user",
			tokensBefore: 100,
		},
		fromExtension: true,
	};
}

function createBeforeAgentStartEvent(): BeforeAgentStartEvent {
	return {
		type: "before_agent_start",
		prompt: "continue",
		systemPrompt: "base prompt",
		systemPromptOptions: {} as BeforeAgentStartEvent["systemPromptOptions"],
	};
}

describe("restoration gate honors runtime compaction settings", () => {
	describe("Given compaction.restorationEnabled is false in the session settings", () => {
		describe("When an accepted compaction is followed by the next agent start", () => {
			it("Then no restoration payload is injected", async () => {
				// Given
				const harness = createRestorationGateHarness();
				const ctx = createGateExtensionContext({ ...DEFAULT_COMPACTION_SETTINGS, restorationEnabled: false });
				await harness.toolCall(
					{ type: "tool_call", toolCallId: "t1", toolName: "read", input: { path: "lost-context.ts" } },
					ctx,
				);

				// When
				await harness.sessionCompact(createAcceptedCompactEvent(), ctx);
				const result = await harness.beforeAgentStart(createBeforeAgentStartEvent(), ctx);

				// Then
				expect(result?.message).toBeUndefined();
			});
		});
	});

	describe("Given compaction.restorationEnabled is true with a runtime restorationMaxItems of 1", () => {
		describe("When an accepted compaction is followed by the next agent start", () => {
			it("Then the restoration payload is injected and capped by the runtime settings", async () => {
				// Given
				const harness = createRestorationGateHarness();
				const ctx = createGateExtensionContext({
					...DEFAULT_COMPACTION_SETTINGS,
					restorationEnabled: true,
					restorationMaxItems: 1,
				});
				await harness.toolCall(
					{ type: "tool_call", toolCallId: "t1", toolName: "read", input: { path: "read-only.ts" } },
					ctx,
				);
				await harness.toolCall(
					{
						type: "tool_call",
						toolCallId: "t2",
						toolName: "edit",
						input: { path: "edited.ts", oldText: "old", newText: "new" },
					},
					ctx,
				);

				// When
				await harness.sessionCompact(createAcceptedCompactEvent(), ctx);
				const result = await harness.beforeAgentStart(createBeforeAgentStartEvent(), ctx);

				// Then
				expect(result?.message?.customType).toBe("compaction.post-compact-restoration");
				expect(result?.message?.content).toContain("edited.ts");
				expect(result?.message?.content).not.toContain("read-only.ts");
			});
		});
	});
});

describe("post-compact restoration tracker", () => {
	describe("Given file and skill tool calls were observed before compaction", () => {
		describe("When session_compact is accepted", () => {
			it("Then a restoration payload is computed but not consumed until before_agent_start", () => {
				// Given
				const state = createRestorationTrackerState();
				trackToolCall(state, { toolName: "read", input: { path: "src/core/agent-session.ts" } });
				trackToolCall(state, { toolName: "edit", input: { path: "src/core/extensions/runner.ts" } });
				trackToolCall(state, {
					toolName: "apply_patch",
					input: { input: "*** Begin Patch\n*** Update File: test.ts\n@@\n-old\n+new\n*** End Patch" },
				});
				trackToolCall(state, { toolName: "skill", input: { name: "typescript-programmer" } });

				// When
				preparePendingPayload(state, {
					accepted: true,
					reason: "manual",
					compactionEntryId: "compact-1",
					contextWindow: 100_000,
					usageTokens: 50_000,
					reserveTokens: 10_000,
					settings: { restorationMaxTotalTokens: 30_000 },
				});

				// Then
				expect(state.pendingPayload).toBeDefined();
				expect(state.pendingPayload?.content).toContain("src/core/agent-session.ts");
				expect(state.pendingPayload?.content).toContain("src/core/extensions/runner.ts");
				expect(state.pendingPayload?.content).toContain("test.ts");
				expect(state.pendingPayload?.content).toContain("typescript-programmer");
				expect(state.pendingPayload?.content).toContain("reason: manual");
			});
		});
	});

	describe("Given a pending restoration payload exists after session_compact", () => {
		describe("When before_agent_start consumes it twice", () => {
			it("Then the custom message is injected only on the next start", () => {
				// Given
				const state = createRestorationTrackerState();
				trackToolCall(state, { toolName: "read", input: { path: "src/index.ts" } });
				preparePendingPayload(state, {
					accepted: true,
					reason: "threshold",
					compactionEntryId: "compact-2",
					contextWindow: 80_000,
					usageTokens: null,
					reserveTokens: 8_000,
					settings: { restorationMaxTotalTokens: 20_000 },
				});

				// When
				const first = consumePendingPayload(state);
				const second = consumePendingPayload(state);

				// Then
				expect(first?.customType).toBe("compaction.post-compact-restoration");
				expect(first?.display).toBe(false);
				expect(first?.content).toContain("src/index.ts");
				expect(second).toBeUndefined();
				expect(state.pendingPayload).toBeNull();
			});
		});
	});

	describe("Given dynamic budget inputs where context ratio is the tightest limit", () => {
		describe("When the restoration budget is computed", () => {
			it("Then the budget is min(config.maxTotalTokens, contextWindow*ratio, contextWindow-usage-reserve)", () => {
				// Given
				const options = {
					accepted: true,
					reason: "overflow" as const,
					compactionEntryId: "compact-3",
					contextWindow: 100_000,
					usageTokens: 10_000,
					reserveTokens: 5_000,
					settings: { restorationMaxTotalTokens: 30_000, restorationContextRatio: 0.15 },
				};

				// When
				const budget = computeRestorationBudget(options);

				// Then
				expect(budget).toBe(15_000);
			});
		});
	});

	describe("Given dynamic budget inputs where remaining context is the tightest limit", () => {
		describe("When the restoration budget is computed", () => {
			it("Then contextWindow minus usage minus reserve caps the payload", () => {
				// Given
				const options = {
					accepted: true,
					reason: "pre_prompt" as const,
					compactionEntryId: "compact-4",
					contextWindow: 100_000,
					usageTokens: 88_000,
					reserveTokens: 5_000,
					settings: { restorationMaxTotalTokens: 30_000, restorationContextRatio: 0.15 },
				};

				// When
				const budget = computeRestorationBudget(options);

				// Then
				expect(budget).toBe(7_000);
			});
		});
	});

	describe("Given a tracked file path already appears in kept post-compaction messages", () => {
		describe("When a restoration payload is prepared with those kept messages", () => {
			it("Then that file is filtered out and not restored", () => {
				// Given
				const state = createRestorationTrackerState();
				trackToolCall(state, { toolName: "read", input: { path: "kept.ts" } });
				trackToolCall(state, { toolName: "read", input: { path: "lost.ts" } });

				// When
				preparePendingPayload(state, {
					accepted: true,
					reason: "manual",
					compactionEntryId: "compact-kept",
					contextWindow: 100_000,
					usageTokens: 10_000,
					reserveTokens: 5_000,
					settings: { restorationMaxTotalTokens: 30_000 },
					keptMessages: [
						{
							role: "assistant",
							api: "faux",
							provider: "faux",
							model: "faux",
							content: [{ type: "text", text: "Already kept context mentions kept.ts explicitly." }],
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "stop",
							timestamp: 0,
						},
					],
				});

				// Then
				expect(state.pendingPayload?.content).not.toContain("kept.ts");
				expect(state.pendingPayload?.content).toContain("lost.ts");
			});
		});
	});

	describe("Given an oversized restoration item", () => {
		describe("When restorationMaxTokensPerItem is smaller than the item", () => {
			it("Then the item content is truncated with a truncation notice", () => {
				// Given
				const state = createRestorationTrackerState();
				trackToolCall(state, { toolName: "skill", input: { name: "x".repeat(400) } });

				// When
				preparePendingPayload(state, {
					accepted: true,
					reason: "manual",
					compactionEntryId: "compact-truncate",
					contextWindow: 100_000,
					usageTokens: 10_000,
					reserveTokens: 5_000,
					settings: { restorationMaxTokensPerItem: 10, restorationMaxTotalTokens: 30_000 },
				});

				// Then
				expect(state.pendingPayload?.content).toContain("[... truncated]");
				expect(state.pendingPayload?.details.items[0]?.tokens).toBeLessThanOrEqual(10);
			});
		});
	});

	describe("Given a restoration payload was already injected after the first compaction", () => {
		describe("When a second compaction happens after a new file is tracked", () => {
			it("Then only newly tracked unrestored items are injected", () => {
				// Given
				const state = createRestorationTrackerState();
				trackToolCall(state, { toolName: "read", input: { path: "first.ts" } });
				preparePendingPayload(state, {
					accepted: true,
					reason: "manual",
					compactionEntryId: "compact-first",
					contextWindow: 100_000,
					usageTokens: 10_000,
					reserveTokens: 5_000,
					settings: { restorationMaxTotalTokens: 30_000 },
				});
				consumePendingPayload(state);
				trackToolCall(state, { toolName: "edit", input: { path: "second.ts" } });

				// When
				preparePendingPayload(state, {
					accepted: true,
					reason: "manual",
					compactionEntryId: "compact-second",
					contextWindow: 100_000,
					usageTokens: 10_000,
					reserveTokens: 5_000,
					settings: { restorationMaxTotalTokens: 30_000 },
				});

				// Then
				expect(state.pendingPayload?.content).not.toContain("first.ts");
				expect(state.pendingPayload?.content).toContain("second.ts");
			});
		});
	});

	describe("Given file and skill items are selected for restoration", () => {
		describe("When the restoration message is built", () => {
			it("Then files and skills are wrapped in plural XML sections", () => {
				// Given
				const state = createRestorationTrackerState();
				trackToolCall(state, { toolName: "read", input: { path: "file.ts" } });
				trackToolCall(state, { toolName: "skill", input: { name: "typescript-programmer" } });

				// When
				preparePendingPayload(state, {
					accepted: true,
					reason: "manual",
					compactionEntryId: "compact-xml",
					contextWindow: 100_000,
					usageTokens: 10_000,
					reserveTokens: 5_000,
					settings: { restorationMaxTotalTokens: 30_000 },
				});

				// Then
				expect(state.pendingPayload?.content).toContain("<restored-files>");
				expect(state.pendingPayload?.content).toContain("</restored-files>");
				expect(state.pendingPayload?.content).toContain("<restored-skills>");
				expect(state.pendingPayload?.content).toContain("</restored-skills>");
			});
		});
	});

	describe("Given restorationMaxItems is 2 and three tracked items exist", () => {
		describe("When a payload is prepared", () => {
			it("Then only the two highest-priority items are kept", () => {
				// Given
				const state = createRestorationTrackerState();
				trackToolCall(state, { toolName: "read", input: { path: "read-only.ts" } });
				trackToolCall(state, { toolName: "edit", input: { path: "edited.ts" } });
				trackToolCall(state, { toolName: "skill", input: { name: "typescript-programmer" } });

				// When
				preparePendingPayload(state, {
					accepted: true,
					reason: "manual",
					compactionEntryId: "compact-5",
					contextWindow: 100_000,
					usageTokens: 10_000,
					reserveTokens: 5_000,
					settings: { restorationMaxItems: 2, restorationMaxTotalTokens: 30_000 },
				});

				// Then
				expect(state.pendingPayload?.content).toContain("edited.ts");
				expect(state.pendingPayload?.content).toContain("typescript-programmer");
				expect(state.pendingPayload?.content).not.toContain("read-only.ts");
			});
		});
	});
});
