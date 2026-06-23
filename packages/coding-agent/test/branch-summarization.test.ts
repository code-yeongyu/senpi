import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateBranchSummary, prepareBranchEntries } from "../src/core/compaction/index.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

function createModel(): Model<"anthropic-messages"> {
	return {
		id: "branch-summary-model",
		name: "Branch Summary Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

function createAssistantResponse(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createEntries(): SessionEntry[] {
	return [
		{
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: {
				role: "user",
				content: [{ type: "text", text: "Investigate compaction regression." }],
				timestamp: 1,
			},
		},
		{
			type: "message",
			id: "entry-2",
			parentId: "entry-1",
			timestamp: new Date().toISOString(),
			message: createAssistantResponse("I am checking branch summarization."),
		},
		{
			type: "custom_message",
			id: "entry-3",
			parentId: "entry-2",
			timestamp: new Date().toISOString(),
			customType: "test.note",
			display: true,
			content: "Remember the branch-specific observation.",
		},
	];
}

describe("branch summarization custom messages", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(createAssistantResponse("## Goal\nKeep branch context"));
	});

	it("keeps custom messages in prepareBranchEntries", () => {
		// given
		const entries = createEntries();

		// when
		const result = prepareBranchEntries(entries);

		// then
		expect(result.messages).toHaveLength(3);
		expect(result.messages.some((message) => message.role === "custom")).toBe(true);
	});

	it("includes custom messages in branch summary prompts", async () => {
		// given
		const entries = createEntries();

		// when
		await generateBranchSummary(entries, {
			model: createModel(),
			apiKey: "test-key",
			signal: new AbortController().signal,
		});

		// then
		const promptText = completeSimpleMock.mock.calls[0][1].messages[0].content[0].text;
		expect(promptText).toContain("Investigate compaction regression.");
		expect(promptText).toContain("I am checking branch summarization.");
		expect(promptText).toContain("Remember the branch-specific observation.");
	});
});
