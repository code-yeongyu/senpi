import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message, ToolResultMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { prePruneToolOutputsToBudget } from "../../src/core/extensions/builtin/compaction/tool-truncation.js";
import {
	type FileEntry,
	migrateSessionEntries,
	parseSessionEntries,
	type SessionMessageEntry,
} from "../../src/core/session-manager.js";

const PRE_PRUNE_TARGET_RATIO = 0.6;
const TEST_DIR = dirname(fileURLToPath(import.meta.url));

function loadFixtureMessages(relativePath: string): Message[] {
	const fixturePath = join(TEST_DIR, "../fixtures/compaction", relativePath);
	const content = readFileSync(fixturePath, "utf-8");
	const fileEntries: FileEntry[] = parseSessionEntries(content);
	migrateSessionEntries(fileEntries);
	const messages: Message[] = [];
	for (const entry of fileEntries) {
		if (entry.type !== "message") continue;
		const messageEntry = entry as SessionMessageEntry;
		const message = messageEntry.message as Message;
		if (message.role === "toolResult") {
			messages.push({ ...message, isError: message.isError ?? false });
			continue;
		}
		messages.push(message);
	}
	return messages;
}

function approxTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function totalTokens(messages: Message[]): number {
	let total = 0;
	for (const message of messages) {
		if (typeof message.content === "string") {
			total += approxTokens(message.content);
			continue;
		}
		for (const block of message.content) {
			if (block.type === "text") {
				total += approxTokens(block.text);
				continue;
			}
			if (block.type === "toolCall") {
				total += approxTokens(JSON.stringify(block.arguments));
				continue;
			}
			if (block.type === "image") {
				total += approxTokens(block.data);
			}
		}
	}
	return total;
}

function toolOutputTokens(messages: Message[]): number {
	let total = 0;
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		for (const block of message.content) {
			if (block.type === "text") {
				total += approxTokens(block.text);
			}
		}
	}
	return total;
}

function toolResultsAsAgentToolResults(messages: Message[]): AgentToolResult<unknown>[] {
	const results: AgentToolResult<unknown>[] = [];
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		results.push({
			content: message.content,
			details: undefined,
		});
	}
	return results;
}

function applyPrunedOutputsToMessages(
	originalMessages: Message[],
	prunedResults: AgentToolResult<unknown>[],
): Message[] {
	const next: Message[] = [];
	let prunedIndex = 0;
	for (const message of originalMessages) {
		if (message.role !== "toolResult") {
			next.push(message);
			continue;
		}
		const replacement = prunedResults[prunedIndex];
		prunedIndex++;
		if (!replacement) continue;
		const repaired: ToolResultMessage = {
			...message,
			content: replacement.content,
		};
		next.push(repaired);
	}
	return next;
}

function lastUserMessage(messages: Message[]): Message | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") return messages[i];
	}
	return undefined;
}

describe("compaction pre-prune behavior", () => {
	describe("Given session at 70% context", () => {
		describe("When pre-prune runs", () => {
			it("Then no pruning (already below 60%)", () => {
				const messages = loadFixtureMessages("pre-prune/oversized-with-pairs.jsonl");
				const initialToolOutputs = toolOutputTokens(messages);
				const contextWindow = Math.ceil(initialToolOutputs / 0.7);
				const budget = Math.floor(contextWindow * PRE_PRUNE_TARGET_RATIO);
				const inputs = toolResultsAsAgentToolResults(messages);
				const undersizedSubset = inputs.slice(0, 1);

				const pruned = prePruneToolOutputsToBudget(undersizedSubset, budget);

				expect(pruned).toHaveLength(undersizedSubset.length);
				expect(pruned[0]?.content).toEqual(undersizedSubset[0].content);
			});
		});
	});

	describe("Given session at 95% context with 80% in tool outputs", () => {
		describe("When pre-prune runs", () => {
			it("Then output reduced to <=60% AND last user message preserved verbatim", () => {
				const messages = loadFixtureMessages("pre-prune/oversized-with-pairs.jsonl");
				const totalBefore = totalTokens(messages);
				const contextWindow = Math.ceil(totalBefore / 0.95);
				const budget = Math.floor(contextWindow * PRE_PRUNE_TARGET_RATIO);
				const userBefore = lastUserMessage(messages);
				expect(userBefore, "fixture must contain at least one user message").toBeDefined();

				const inputs = toolResultsAsAgentToolResults(messages);
				const pruned = prePruneToolOutputsToBudget(inputs, budget);
				const reconstructed = applyPrunedOutputsToMessages(messages, pruned);
				const userAfter = lastUserMessage(reconstructed);
				const totalAfter = totalTokens(reconstructed);

				expect(totalAfter, "pruned context must fit within 60% budget").toBeLessThanOrEqual(budget);
				expect(userAfter, "last user message must survive pre-prune").toEqual(userBefore);
			});
		});
	});

	describe("Given assistant message with tool_call followed by tool_result", () => {
		describe("When pre-prune runs", () => {
			it("Then pair preserved (never split)", () => {
				const messages = loadFixtureMessages("pre-prune/oversized-with-pairs.jsonl");
				const contextWindow = Math.ceil(totalTokens(messages) / 0.95);
				const budget = Math.floor(contextWindow * PRE_PRUNE_TARGET_RATIO);
				const inputs = toolResultsAsAgentToolResults(messages);

				const pruned = prePruneToolOutputsToBudget(inputs, budget);
				const reconstructed = applyPrunedOutputsToMessages(messages, pruned);

				const toolCallIds = new Set<string>();
				for (const message of reconstructed) {
					if (message.role !== "assistant") continue;
					for (const block of message.content) {
						if (block.type === "toolCall") {
							toolCallIds.add(block.id);
						}
					}
				}
				const toolResultIds = new Set<string>();
				for (const message of reconstructed) {
					if (message.role !== "toolResult") continue;
					toolResultIds.add(message.toolCallId);
				}

				for (const id of toolResultIds) {
					expect(toolCallIds.has(id), `tool_result ${id} must have matching tool_call`).toBe(true);
				}
				for (const id of toolCallIds) {
					expect(toolResultIds.has(id), `tool_call ${id} must retain its tool_result after pre-prune`).toBe(true);
				}
			});
		});
	});

	describe("Given pre-prune runs", () => {
		describe("When summary generation invoked", () => {
			it("Then summarizer input fits within token budget", () => {
				const messages = loadFixtureMessages("pre-prune/oversized-with-pairs.jsonl");
				const contextWindow = Math.ceil(totalTokens(messages) / 0.95);
				const summarizerBudget = Math.floor(contextWindow * PRE_PRUNE_TARGET_RATIO);
				const inputs = toolResultsAsAgentToolResults(messages);

				const pruned = prePruneToolOutputsToBudget(inputs, summarizerBudget);
				const reconstructed = applyPrunedOutputsToMessages(messages, pruned);
				const summarizerInputTokens = totalTokens(reconstructed);

				expect(
					summarizerInputTokens,
					"summarizer input must fit token budget for downstream summary generation",
				).toBeLessThanOrEqual(summarizerBudget);
			});
		});
	});
});
