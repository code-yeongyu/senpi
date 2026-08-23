import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	clearOldToolResults,
	collapseConsecutiveToolResults,
	microCompactAssistantText,
	reduceContextMessages,
	shouldApplyContextReduction,
} from "../../src/core/extensions/builtin/compaction/context-reduction.ts";

let timestampCounter = 0;
function ts(): number {
	timestampCounter += 1;
	return timestampCounter;
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function userMsg(text: string): UserMessage {
	return { role: "user", content: text, timestamp: ts() };
}

function assistantToolCall(toolCallId: string, toolName: string, args: Record<string, unknown>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: args }],
		api: "faux-completion",
		provider: "faux",
		model: "faux-model",
		usage: emptyUsage(),
		stopReason: "toolUse",
		timestamp: ts(),
	};
}

function toolResult(toolCallId: string, toolName: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: ts(),
	};
}

function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux-completion",
		provider: "faux",
		model: "faux-model",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: ts(),
	};
}

function firstText(blocks: { type: string; text?: string }[]): string {
	for (const block of blocks) {
		if (block.type === "text" && typeof block.text === "string") return block.text;
	}
	return "";
}

describe("compaction context reduction behavior", () => {
	describe("Given five consecutive 'read' tool result pairs in older history", () => {
		describe("When collapseConsecutiveToolResults runs with protectRecentMessages=2", () => {
			it("Then the older five read payloads collapse into a single-line label and the recent two messages stay untouched", () => {
				// Given
				const messages: AgentMessage[] = [];
				for (let i = 0; i < 5; i++) {
					messages.push(assistantToolCall(`r${i}`, "read", { path: `src/file-${i}.ts` }));
					messages.push(toolResult(`r${i}`, "read", `payload of file-${i} ${"A".repeat(800)}`));
				}
				const recentUser = userMsg("recent followup");
				const recentAssistant = assistantText("recent answer");
				messages.push(recentUser, recentAssistant);

				// When
				const result = collapseConsecutiveToolResults(messages, {
					minGroupSize: 2,
					protectRecentMessages: 2,
				});

				// Then
				const collapsedResults = result.messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
				expect(collapsedResults.length).toBe(5);
				for (const tr of collapsedResults) {
					const text = firstText(tr.content);
					expect(text).toMatch(/^\[5 read results/);
					expect(text).not.toContain("AAAAAAAA");
				}
				expect(result.groups.length).toBe(1);
				expect(result.groups[0].type).toBe("read");
				expect(result.groups[0].count).toBe(5);
				expect(result.tokensSaved).toBeGreaterThan(0);

				expect(result.messages[result.messages.length - 2]).toEqual(recentUser);
				expect(result.messages[result.messages.length - 1]).toEqual(recentAssistant);
			});
		});
	});

	describe("Given two consecutive grep results then two consecutive bash results", () => {
		describe("When collapseConsecutiveToolResults runs with minGroupSize=2 protectRecentMessages=1", () => {
			it("Then it produces one 'search' group and one 'shell' group without merging across categories", () => {
				// Given
				const messages: AgentMessage[] = [
					assistantToolCall("g1", "grep", { pattern: "foo", path: "src" }),
					toolResult("g1", "grep", "match a"),
					assistantToolCall("g2", "grep", { pattern: "bar", path: "src" }),
					toolResult("g2", "grep", "match b"),
					assistantToolCall("b1", "bash", { command: "ls" }),
					toolResult("b1", "bash", "file1\nfile2"),
					assistantToolCall("b2", "bash", { command: "pwd" }),
					toolResult("b2", "bash", "/home"),
					userMsg("recent"),
				];

				// When
				const result = collapseConsecutiveToolResults(messages, {
					minGroupSize: 2,
					protectRecentMessages: 1,
				});

				// Then
				expect(result.groups.length).toBe(2);
				expect(result.groups.find((g) => g.type === "search")?.count).toBe(2);
				expect(result.groups.find((g) => g.type === "shell")?.count).toBe(2);
			});
		});
	});

	describe("Given an older long assistant text and a short recent assistant text", () => {
		describe("When microCompactAssistantText runs with maxAssistantTextTokens=50 protectRecentTokens=10", () => {
			it("Then the older assistant text is shrunk in place and the recent assistant text stays intact", () => {
				// Given
				const oldText = "very long answer ".repeat(200);
				const recentText = "ok";
				const messages: AgentMessage[] = [
					userMsg("first question"),
					assistantText(oldText),
					userMsg("second question"),
					assistantText(recentText),
				];

				// When
				const result = microCompactAssistantText(messages, {
					maxAssistantTextTokens: 50,
					protectRecentTokens: 10,
				});

				// Then
				expect(result.messagesModified).toBe(1);
				expect(result.tokensSaved).toBeGreaterThan(0);

				const olderAssistant = result.messages[1] as AssistantMessage;
				const olderTextActual = firstText(olderAssistant.content as { type: string; text?: string }[]);
				expect(olderTextActual).toContain("[response shrunk");
				expect(olderTextActual.length).toBeLessThan(oldText.length);

				const recentAssistant = result.messages[3] as AssistantMessage;
				const recentTextActual = firstText(recentAssistant.content as { type: string; text?: string }[]);
				expect(recentTextActual).toBe(recentText);
			});
		});
	});

	describe("Given six clearable tool result pairs in chronological order", () => {
		describe("When clearOldToolResults runs with keepRecent=3", () => {
			it("Then the older three tool results are replaced with a placeholder and the last three keep original content", () => {
				// Given
				const messages: AgentMessage[] = [];
				for (let i = 0; i < 6; i++) {
					messages.push(assistantToolCall(`t${i}`, "read", { path: `f${i}.ts` }));
					messages.push(toolResult(`t${i}`, "read", `payload-${i}-${"X".repeat(2000)}`));
				}

				// When
				const result = clearOldToolResults(messages, { keepRecent: 3 });

				// Then
				expect(result.toolResultsCleared).toBe(3);
				expect(result.tokensSaved).toBeGreaterThan(0);

				const toolResults = result.messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
				expect(toolResults.length).toBe(6);
				for (let i = 0; i < 3; i++) {
					expect(firstText(toolResults[i].content)).toBe("[tool result cleared]");
				}
				for (let i = 3; i < 6; i++) {
					const text = firstText(toolResults[i].content);
					expect(text).toContain(`payload-${i}-`);
					expect(text.length).toBeGreaterThan(1000);
				}
			});
		});
	});

	describe("Given an older assistant message that mixes a long text block with a toolCall block", () => {
		describe("When microCompactAssistantText runs", () => {
			it("Then the mixed-content assistant message is NOT shrunk because dropping the toolCall would break the tool-call/result pair", () => {
				// Given
				const longText = "stuff ".repeat(500);
				const mixed: AssistantMessage = {
					role: "assistant",
					content: [
						{ type: "text", text: longText },
						{ type: "toolCall", id: "mixed", name: "read", arguments: { path: "f.ts" } },
					],
					api: "faux-completion",
					provider: "faux",
					model: "faux-model",
					usage: emptyUsage(),
					stopReason: "toolUse",
					timestamp: ts(),
				};
				const messages: AgentMessage[] = [
					userMsg("prologue"),
					mixed,
					toolResult("mixed", "read", "file body"),
					userMsg("recent"),
				];

				// When
				const result = microCompactAssistantText(messages, {
					protectRecentTokens: 10,
					maxAssistantTextTokens: 10,
				});

				// Then
				expect(result.messagesModified).toBe(0);
				expect(result.messages[1]).toBe(mixed);
			});
		});
	});

	describe("Given a transcript where a non-clearable tool result sits among older clearable tool results", () => {
		describe("When clearOldToolResults runs with keepRecent=3", () => {
			it("Then only clearable tool results are touched and the non-clearable result is preserved", () => {
				// Given
				const messages: AgentMessage[] = [];
				for (let i = 0; i < 4; i += 1) {
					messages.push(assistantToolCall(`r${i}`, "read", { path: `f${i}.ts` }));
					messages.push(toolResult(`r${i}`, "read", `read-payload-${i}-${"X".repeat(2000)}`));
				}
				messages.push(assistantToolCall("custom", "custom_tool", { foo: "bar" }));
				messages.push(toolResult("custom", "custom_tool", `custom-payload-${"Y".repeat(2000)}`));
				for (let i = 0; i < 4; i += 1) {
					const id = `r${i + 10}`;
					messages.push(assistantToolCall(id, "read", { path: `g${i}.ts` }));
					messages.push(toolResult(id, "read", `more-read-payload-${i}-${"Z".repeat(2000)}`));
				}

				// When
				const result = clearOldToolResults(messages, { keepRecent: 3 });

				// Then
				expect(result.toolResultsCleared).toBe(5);
				const nonClearable = result.messages.find(
					(m): m is ToolResultMessage => m.role === "toolResult" && m.toolName === "custom_tool",
				);
				expect(nonClearable).toBeDefined();
				const nonClearableText = firstText(nonClearable?.content ?? []);
				expect(nonClearableText).toContain("custom-payload-");
				expect(nonClearableText.length).toBeGreaterThan(1000);
			});
		});
	});

	describe("Given various usage / context-window / provider-native states", () => {
		describe("When shouldApplyContextReduction is consulted", () => {
			it("Then it returns false below 50% usage, true at or above 50% usage, false on the provider-native path, and false when usage is unknown or contextWindow is zero", () => {
				// Given / When / Then
				expect(shouldApplyContextReduction({ usageTokens: 49_000, contextWindow: 100_000 })).toBe(false);
				expect(shouldApplyContextReduction({ usageTokens: 50_000, contextWindow: 100_000 })).toBe(true);
				expect(shouldApplyContextReduction({ usageTokens: 80_000, contextWindow: 100_000 })).toBe(true);
				expect(
					shouldApplyContextReduction({
						usageTokens: 90_000,
						contextWindow: 100_000,
						isProviderNativeCompactionPath: true,
					}),
				).toBe(false);
				expect(shouldApplyContextReduction({ usageTokens: null, contextWindow: 100_000 })).toBe(false);
				expect(shouldApplyContextReduction({ usageTokens: 50_000, contextWindow: 0 })).toBe(false);
			});
		});
	});

	describe("Given a transcript with five collapsible reads, one shrinkable assistant text, and six clearable tool results", () => {
		describe("When reduceContextMessages runs with default options", () => {
			it("Then collapse + shrink + clear all apply and tokensSaved aggregates all three categories", () => {
				// Given
				const messages: AgentMessage[] = [];
				messages.push(userMsg("very first user"));
				messages.push(assistantText("long old answer ".repeat(300)));
				for (let i = 0; i < 5; i++) {
					messages.push(assistantToolCall(`r${i}`, "read", { path: `src/a-${i}.ts` }));
					messages.push(toolResult(`r${i}`, "read", `payload-r${i}-${"Y".repeat(2000)}`));
				}
				for (let i = 0; i < 6; i++) {
					messages.push(assistantToolCall(`b${i}`, "bash", { command: `echo ${i}` }));
					messages.push(toolResult(`b${i}`, "bash", `bash-out-${i}-${"Z".repeat(2000)}`));
				}
				messages.push(userMsg("recent prompt"));
				messages.push(assistantText("recent reply"));

				const totalBefore = messages.length;

				// When
				const result = reduceContextMessages(messages);

				// Then
				expect(result.messages.length).toBe(totalBefore);
				expect(result.groupsCollapsed).toBeGreaterThanOrEqual(1);
				expect(result.toolResultsCleared).toBeGreaterThanOrEqual(1);
				expect(result.messagesShrunk).toBeGreaterThanOrEqual(1);
				expect(result.tokensSaved).toBeGreaterThan(0);

				const last = result.messages[result.messages.length - 1] as AssistantMessage;
				expect(firstText(last.content as { type: string; text?: string }[])).toBe("recent reply");
			});
		});
	});

	describe("Sticky generation latch and prefix hash stability", () => {
		it("latches context reduction once engaged and preserves historical prefix shape across threshold oscillations", () => {
			const {
				createContextReductionLatch,
				shouldApplyContextReduction,
			} = require("../../src/core/extensions/builtin/compaction/context-reduction.ts");
			const latch = createContextReductionLatch();
			const contextWindow = 1_000_000;

			// Turn 1: 501k (>= 500k gate) -> engages and latches
			const engaged1 = shouldApplyContextReduction({
				usageTokens: 501_000,
				contextWindow,
				latch,
			});
			expect(engaged1).toBe(true);
			expect(latch.isLatched()).toBe(true);

			// Turn 2: usage dips to 499k (< 500k gate), but latch is ON -> stays engaged
			const engaged2 = shouldApplyContextReduction({
				usageTokens: 499_000,
				contextWindow,
				latch,
			});
			expect(engaged2).toBe(true);
			expect(latch.isLatched()).toBe(true);

			// Turn 3: usage rises to 505k -> stays engaged
			const engaged3 = shouldApplyContextReduction({
				usageTokens: 505_000,
				contextWindow,
				latch,
			});
			expect(engaged3).toBe(true);
			expect(latch.isLatched()).toBe(true);

			// Compaction accepted & persisted -> generation bumps and latch resets
			latch.bumpGeneration();
			expect(latch.isLatched()).toBe(false);
			expect(latch.getGeneration()).toBe(1);

			// After compaction, usage is at 100k -> should NOT engage
			const engagedAfter = shouldApplyContextReduction({
				usageTokens: 100_000,
				contextWindow,
				latch,
			});
			expect(engagedAfter).toBe(false);
			expect(latch.isLatched()).toBe(false);
		});
	});
});
