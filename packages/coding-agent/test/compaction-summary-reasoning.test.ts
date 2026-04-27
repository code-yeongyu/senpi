import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Model } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateSummary } from "../src/core/compaction/index.js";
import { SANEPI_SYSTEM_PREFIX } from "../src/core/extensions/builtin/system-messages.js";

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

function createModel(reasoning: boolean): Model<"anthropic-messages"> {
	return {
		id: reasoning ? "reasoning-model" : "non-reasoning-model",
		name: reasoning ? "Reasoning Model" : "Non-reasoning Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

const mockSummaryResponse: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "## Goal\nTest summary" }],
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

const messages: AgentMessage[] = [{ role: "user", content: "Summarize this.", timestamp: Date.now() }];

describe("generateSummary reasoning options", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(mockSummaryResponse);
	});

	it("uses the provided thinking level for reasoning-capable models", async () => {
		await generateSummary(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			reasoning: "medium",
			apiKey: "test-key",
		});
	});

	it("does not set reasoning when thinking is off", async () => {
		await generateSummary(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"off",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("does not set reasoning for non-reasoning models", async () => {
		await generateSummary(
			messages,
			createModel(false),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("excludes background task system reminders from the summarization prompt", async () => {
		// given
		const currentMessages: AgentMessage[] = [
			{ role: "user", content: "Fix the compaction system.", timestamp: Date.now() },
			{
				role: "custom",
				customType: "background-task.complete",
				content: `${SANEPI_SYSTEM_PREFIX}\n<system-reminder>\nUse background_output(task_id="bg_123")\n</system-reminder>`,
				display: true,
				timestamp: Date.now() + 1,
			},
			{
				...mockSummaryResponse,
				content: [{ type: "text", text: "I found the compaction path." }],
			},
		];

		// when
		await generateSummary(currentMessages, createModel(false), 2000, "test-key");

		// then
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		const promptText = completeSimpleMock.mock.calls[0][1].messages[0].content[0].text;
		expect(promptText).toContain("Fix the compaction system.");
		expect(promptText).not.toContain("background_output(task_id");
		expect(promptText).not.toContain("<system-reminder>");
		expect(promptText).not.toContain(SANEPI_SYSTEM_PREFIX);
	});
});
