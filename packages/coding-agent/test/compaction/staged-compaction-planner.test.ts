import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS, planStagedCompactionChunk } from "../../src/core/compaction/index.ts";
import type { SessionEntry, SessionMessageEntry } from "../../src/core/session-manager.ts";

let nextId = 0;
let parentId: string | null = null;

function entry(message: AgentMessage): SessionMessageEntry {
	const id = `entry-${nextId++}`;
	const result: SessionMessageEntry = {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message,
	};
	parentId = id;
	return result;
}

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop") {
	return {
		role: "assistant" as const,
		content,
		api: "faux-completion" as const,
		provider: "faux",
		model: "faux-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	} satisfies AssistantMessage;
}

function plan(entries: SessionEntry[], budgetTokens: number) {
	return planStagedCompactionChunk(entries, { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 }, budgetTokens);
}

describe("staged compaction chunk planner", () => {
	beforeEach(() => {
		nextId = 0;
		parentId = null;
	});

	it("selects the largest contiguous prefix of complete turns that fits", () => {
		const firstUser = entry(user("a".repeat(80)));
		const firstAssistant = entry(assistant([{ type: "text", text: "b".repeat(80) }]));
		const secondUser = entry(user("c".repeat(80)));
		const secondAssistant = entry(assistant([{ type: "text", text: "d".repeat(80) }]));
		const thirdUser = entry(user("keep newest"));
		const entries = [firstUser, firstAssistant, secondUser, secondAssistant, thirdUser];

		const result = plan(entries, 45);

		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		expect(result.chunk.firstSummarizedEntryId).toBe(firstUser.id);
		expect(result.chunk.lastSummarizedEntryId).toBe(firstAssistant.id);
		expect(result.chunk.preparation.firstKeptEntryId).toBe(secondUser.id);
		expect(result.chunk.preparation.messagesToSummarize).toEqual([firstUser.message, firstAssistant.message]);
	});

	it("keeps a tool call, its result, and the rest of their turn in one chunk", () => {
		const firstUser = entry(user("run tool"));
		const toolCall = entry(
			assistant([{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } }], "toolUse"),
		);
		const toolResult = entry({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "file contents" }],
			isError: false,
			timestamp: Date.now(),
		});
		const finalAssistant = entry(assistant([{ type: "text", text: "done" }]));
		const nextUser = entry(user("next turn"));

		const result = plan([firstUser, toolCall, toolResult, finalAssistant, nextUser], 1_000);

		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		expect(result.chunk.preparation.firstKeptEntryId).toBe(nextUser.id);
		expect(result.chunk.preparation.messagesToSummarize).toEqual([
			firstUser.message,
			toolCall.message,
			toolResult.message,
			finalAssistant.message,
		]);
	});

	it("returns an explicit no-fit result for one oversized oldest entry", () => {
		const oversizedUser = entry(user("x".repeat(4_000)));
		const newestUser = entry(user("keep me"));

		const result = plan([oversizedUser, newestUser], 500);

		expect(result).toMatchObject({
			status: "no-fit",
			reason: "single-group-too-large",
			entryId: oversizedUser.id,
			budgetTokens: 500,
		});
		if (result.status === "no-fit") {
			expect(result.requiredTokens).toBeGreaterThan(result.budgetTokens);
		}
	});
});
