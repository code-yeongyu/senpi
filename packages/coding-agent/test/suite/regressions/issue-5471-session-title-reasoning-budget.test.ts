import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	collectTitleRuntimeErrors,
	createAutoTitleHarness,
	readTitleFailureLog,
} from "../../agent-session-auto-title-helpers.ts";
import { createTestUiContext, type Harness } from "../harness.ts";

// Regression for #5471: a gateway that serves a reasoning model and cannot turn thinking off spends the
// title request's whole completion budget on reasoning, so the answer slot comes back empty.

const TASK_PROMPT = "kill the stale database connections in the pool manager before the nightly job";
const MODEL_TITLE = "Kill Stale Database Connections";
// Reasoning tokens this fake model spends before it writes its answer (the reporter measured ~319).
const REASONING_COST = 320;

interface TitleCall {
	readonly maxTokens: number | undefined;
	readonly reasoning: SimpleStreamOptions["reasoning"];
}

interface Notice {
	readonly message: string;
	readonly type: string | undefined;
}

/**
 * A provider whose model always thinks first and counts the thinking against `maxTokens`: a budget below
 * `reasoningCost` ends at `length` with reasoning only and no text, like the reporter's LiteLLM -> vLLM gateway.
 */
function thinkingFirstProvider(reasoningCost: number, titleCalls: TitleCall[]): FauxResponseFactory {
	return (context, options) => {
		if (!getCurrentSystemPrompt(context.messages).includes("<title>")) {
			return fauxAssistantMessage("turn complete");
		}
		titleCalls.push({ maxTokens: options?.maxTokens, reasoning: options?.reasoning });
		const budget = options?.maxTokens ?? Number.POSITIVE_INFINITY;
		if (budget < reasoningCost) {
			return fauxAssistantMessage(fauxThinking("The user wants a concise title for"), { stopReason: "length" });
		}
		return fauxAssistantMessage([
			fauxThinking("The user wants a concise title for a cleanup task."),
			fauxText(`<title>${MODEL_TITLE}</title>`),
		]);
	};
}

async function harnessWithNotices(
	reasoning: boolean,
	settings?: Parameters<typeof createAutoTitleHarness>[0],
): Promise<{ harness: Harness; notices: Notice[] }> {
	const harness = await createAutoTitleHarness({ models: [{ id: "gateway-reasoner", reasoning }], ...settings });
	const notices: Notice[] = [];
	await harness.session.bindExtensions({
		uiContext: createTestUiContext({ notify: (message, type) => notices.push({ message, type }) }),
	});
	return { harness, notices };
}

describe("issue #5471: session titles on reasoning models that cannot turn thinking off", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it.each([
		{ catalog: "catalogued as reasoning", reasoning: true },
		{ catalog: "catalogued without reasoning", reasoning: false },
	])(
		"retries once with room for the answer when the reasoning used the whole budget ($catalog)",
		async ({ reasoning }) => {
			const titleCalls: TitleCall[] = [];
			const { harness, notices } = await harnessWithNotices(reasoning);
			harnesses.push(harness);
			const respond = thinkingFirstProvider(REASONING_COST, titleCalls);
			harness.setResponses([respond, respond, respond]);

			await harness.session.prompt(TASK_PROMPT);
			await harness.session.waitForSettledSessionWork();

			expect(titleCalls.map((call) => call.maxTokens)).toEqual([64, 1024]);
			expect(titleCalls.every((call) => call.reasoning === undefined)).toBe(true);
			expect(harness.sessionManager.getSessionName()).toBe(MODEL_TITLE);
			expect(notices).toEqual([]);
		},
	);

	it("names the session from the first message, warns once, and stops asking when the model never answers", async () => {
		const titleCalls: TitleCall[] = [];
		const { harness, notices } = await harnessWithNotices(true);
		harnesses.push(harness);
		const titleErrors = collectTitleRuntimeErrors(harness);
		const respond = thinkingFirstProvider(Number.POSITIVE_INFINITY, titleCalls);
		harness.setResponses(Array.from({ length: 8 }, () => respond));

		await harness.session.prompt(TASK_PROMPT);
		await harness.session.waitForSettledSessionWork();
		await harness.session.prompt("now add a regression test for the pool manager");
		await harness.session.waitForSettledSessionWork();

		expect(titleCalls.map((call) => call.maxTokens)).toEqual([64, 1024]);
		expect(harness.sessionManager.getSessionName()).toBe("kill the stale database connections in the pool");
		expect(notices.filter((notice) => notice.type === "warning")).toHaveLength(1);
		expect(titleErrors).toEqual([]);
	});

	it("keeps the cheap reasoning-free request for a model that answers inside it", async () => {
		const titleCalls: TitleCall[] = [];
		const { harness, notices } = await harnessWithNotices(false);
		harnesses.push(harness);
		const respond = thinkingFirstProvider(0, titleCalls);
		harness.setResponses([respond, respond]);

		await harness.session.prompt(TASK_PROMPT);
		await harness.session.waitForSettledSessionWork();

		expect(titleCalls).toEqual([{ maxTokens: 64, reasoning: undefined }]);
		expect(harness.sessionManager.getSessionName()).toBe(MODEL_TITLE);
		expect(notices).toEqual([]);
	});

	it("stops asking after three failed title attempts instead of retrying on every prompt", async () => {
		const { harness } = await harnessWithNotices(false, { settings: { retry: { maxRetries: 0, baseDelayMs: 1 } } });
		harnesses.push(harness);
		let titleAttempts = 0;
		const failingTitle: FauxResponseFactory = (context) => {
			if (!getCurrentSystemPrompt(context.messages).includes("<title>"))
				return fauxAssistantMessage("turn complete");
			titleAttempts += 1;
			return fauxAssistantMessage("", { stopReason: "error", errorMessage: "title provider failed" });
		};
		harness.setResponses(Array.from({ length: 10 }, () => failingTitle));

		for (const prompt of ["fix the OAuth login", "add a mobile test", "update the docs", "clean up the branch"]) {
			await harness.session.prompt(prompt);
			await harness.session.waitForSettledSessionWork();
		}

		expect(titleAttempts).toBe(3);
		expect(readTitleFailureLog(harness).map((entry) => entry.willRetry)).toEqual([true, true, false]);
		expect(harness.sessionManager.getSessionName()).toBeUndefined();
	});
});
