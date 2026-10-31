import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { estimateContextTokens, estimateProjectedContextTokens } from "../../../src/core/compaction/index.ts";
import { createRequiredCompactionFallback } from "../../../src/core/extensions/builtin/compaction/deterministic-fallback.ts";
import { projectModelUsabilityBudget } from "../../../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import { hasUnsafeRetainedContent } from "../../../src/core/extensions/builtin/compaction/retained-message-safety.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/index.ts";
import { convertToLlm } from "../../../src/core/messages.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
const settings = {
	compaction: {
		enabled: true,
		speculativeEnabled: false,
		idleCompactionEnabled: false,
		keepRecentTokens: 2_000,
		reserveTokens: 16_000,
	},
	retry: { enabled: false },
};

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
});

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.useRealTimers();
});

function answerWithUsage(input: number) {
	const answer = fauxAssistantMessage("answer", { timestamp: Date.now() });
	return { ...answer, usage: { ...answer.usage, input, totalTokens: input } };
}

function requireCompaction(harness: Harness): void {
	const projection = projectModelUsabilityBudget({
		model: harness.getModel(),
		systemPrompt: harness.agent.state.systemPrompt,
		tools: harness.agent.state.tools,
		liveContextTokens: 90_000,
		compaction: harness.settingsManager.getCompactionSettings(),
		includeSpeculationLead: false,
		admission: "resume",
	});
	expect(projection.usable).toBe(false);
	harness.session.admitResumeCompactionRequired(projection);
}

async function setup(outcome: "accept" | "reject" | "fail" | "oversized" | "unsafe" = "accept") {
	const attempts: string[] = [];
	let boundary = "";
	const harness = await createHarness({
		models: [{ id: "resume-projection", contextWindow: 100_000, maxTokens: 4_000 }],
		settings,
		extensionFactories: [
			(pi: ExtensionAPI) => {
				pi.on("session_before_compact", (event) => {
					attempts.push(event.reason);
					if (event.reason !== "manual" || outcome === "reject") {
						return { cancel: true, rejectionCause: "external-owner", reason: "provider owns compaction" };
					}
					if (outcome === "fail") throw new Error("summary generation failed");
					if (outcome === "unsafe") {
						const result = createRequiredCompactionFallback(
							{ ...event.preparation, firstKeptEntryId: boundary },
							100_000,
							"summarization-empty-summary",
							{},
							harness.sessionManager.getBranch(),
						);
						expect(result).toBeDefined();
						return { compaction: result };
					}
					return {
						compaction: {
							summary: outcome === "oversized" ? "large summary ".repeat(23_000) : "compact summary",
							firstKeptEntryId: boundary,
							tokensBefore: event.preparation.tokensBefore,
						},
					};
				});
			},
		],
	});
	harnesses.push(harness);
	harness.sessionManager.appendMessage({
		role: "user",
		content: "old context ".repeat(30_000),
		timestamp: Date.now(),
	});
	for (let index = 0; index < 20; index++) {
		harness.sessionManager.appendMessage(fauxAssistantMessage("historical reply ".repeat(500)));
	}
	boundary = harness.sessionManager.appendMessage({
		role: "user",
		content: "retained request",
		timestamp: Date.now(),
	});
	const stale = answerWithUsage(90_000);
	if (outcome === "unsafe") {
		harness.sessionManager.appendMessage({
			...stale,
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "unsafe-result", name: "eval", arguments: {} }],
		});
		const result = {
			role: "toolResult" as const,
			toolCallId: "unsafe-result",
			toolName: "eval",
			content: [{ type: "text" as const, text: "result" }],
			isError: false,
			timestamp: Date.now(),
		};
		Reflect.set(result, "isError", "invalid");
		harness.sessionManager.appendMessage(result);
	} else {
		harness.sessionManager.appendMessage(stale);
	}
	harness.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	requireCompaction(harness);
	await harness.session.bindExtensions({});
	return { harness, attempts };
}

describe("#3062: resume uses context projected after accepted compaction", () => {
	it("admits the next prompt without re-compacting retained pre-checkpoint usage", async () => {
		const { harness, attempts } = await setup();
		await harness.session.compact();
		expect(estimateContextTokens(harness.session.messages).tokens).toBeGreaterThanOrEqual(90_000);
		harness.setResponses([answerWithUsage(1_000)]);

		await harness.session.prompt("continue");

		expect(harness.faux.getCallLog()).toHaveLength(1);
		expect(attempts).toEqual(["manual"]);
	});

	it.each(["reject", "fail"] as const)("keeps old usage when manual compaction %ss", async (outcome) => {
		const { harness } = await setup(outcome);
		await expect(harness.session.compact()).rejects.toThrow();
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
		expect(
			estimateProjectedContextTokens(
				harness.sessionManager.buildSessionProjection(),
				harness.sessionManager.getBranch(),
			).usageTokens,
		).toBeGreaterThanOrEqual(90_000);
		const callsBefore = harness.faux.getCallLog().length;

		await expect(harness.session.prompt("continue")).rejects.toThrow(/compaction threshold/);

		expect(harness.faux.getCallLog()).toHaveLength(callsBefore);
	});

	it("still refuses when the accepted summary and retained messages exceed the envelope", async () => {
		const { harness } = await setup("oversized");
		await harness.session.compact();
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(true);

		await expect(harness.session.prompt("continue")).rejects.toThrow(/compaction threshold/);

		expect(harness.faux.getCallLog()).toHaveLength(0);
	});

	it.each([1_000, 90_000])("uses fresh provider usage of %i instead of the checkpoint projection", async (input) => {
		const { harness, attempts } = await setup();
		await harness.session.compact();
		harness.sessionManager.appendMessage(answerWithUsage(input));
		harness.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		requireCompaction(harness);
		harness.setResponses([answerWithUsage(1_000)]);
		expect(
			estimateProjectedContextTokens(
				harness.sessionManager.buildSessionProjection(),
				harness.sessionManager.getBranch(),
			).usageTokens,
		).toBeGreaterThanOrEqual(input);

		if (input === 90_000) {
			await expect(harness.session.prompt("continue")).rejects.toThrow(/compaction threshold/);
			expect(harness.faux.getCallLog()).toHaveLength(0);
			expect(attempts.filter((reason) => reason === "manual")).toHaveLength(1);
		} else {
			await harness.session.prompt("continue");
			expect(harness.faux.getCallLog()).toHaveLength(1);
			expect(attempts).toEqual(["manual"]);
		}
	});

	it("admits the repaired #3060 suffix while keeping its original persisted result", async () => {
		const { harness, attempts } = await setup("unsafe");
		const original = harness.sessionManager.getBranch().at(-1);
		await harness.session.compact();
		expect(hasUnsafeRetainedContent(convertToLlm(harness.session.messages))).toBe(false);
		expect(harness.sessionManager.getBranch().find((entry) => entry.id === original?.id)).toEqual(original);
		harness.setResponses([answerWithUsage(1_000)]);

		await harness.session.prompt("continue");

		expect(harness.faux.getCallLog()).toHaveLength(1);
		expect(attempts).toEqual(["manual"]);
	});
});
