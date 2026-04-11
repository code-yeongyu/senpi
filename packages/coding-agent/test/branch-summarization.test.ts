import type { AssistantMessage, Model } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateBranchSummary, prepareBranchEntries } from "../src/core/compaction/index.js";
import { SANEPI_SYSTEM_PREFIX } from "../src/core/extensions/builtin/system-messages.js";
import type { SessionEntry } from "../src/core/session-manager.js";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();
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
			customType: "background-task.complete",
			display: true,
			content: `${SANEPI_SYSTEM_PREFIX}\n<system-reminder>\nUse background_output(task_id="bg_123")\n</system-reminder>`,
		},
	];
}

describe("branch summarization exclusions", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(createAssistantResponse("## Goal\nKeep branch context"));
	});

	it("filters background task reminders from prepareBranchEntries", () => {
		// given
		const entries = createEntries();

		// when
		const result = prepareBranchEntries(entries);

		// then
		expect(result.messages).toHaveLength(2);
		expect(result.messages.some((message) => message.role === "custom")).toBe(false);
	});

	it("excludes background task reminders from branch summary prompts", async () => {
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
		expect(promptText).not.toContain("background_output(task_id");
		expect(promptText).not.toContain("<system-reminder>");
		expect(promptText).not.toContain(SANEPI_SYSTEM_PREFIX);
	});
});
