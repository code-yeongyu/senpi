import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { estimateProjectedContextTokens } from "../../../src/core/compaction/index.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/index.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-10-12T00:00:00Z"));
});

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.useRealTimers();
});

function answerWithUsage(input: number) {
	const answer = fauxAssistantMessage("answer", { timestamp: Date.now() });
	return { ...answer, usage: { ...answer.usage, input, totalTokens: input } };
}

async function setup(contextWindow = 400_000, outcome: "accept" | "fail" | "reject" | "abort" = "accept") {
	let boundary = "";
	const attempts: string[] = [];
	const resourceLoader = createTestResourceLoader({
		extensionsResult: await createTestExtensionsResult([
			(pi: ExtensionAPI) => {
				pi.on("session_before_compact", (event) => {
					attempts.push(event.reason);
					if (event.reason !== "manual" || outcome === "reject") {
						return { cancel: true, rejectionCause: "cancelled-by-extension", reason: "refused" };
					}
					if (outcome === "fail") throw new Error("summary generation failed");
					if (outcome === "abort") {
						harness.session.abortCompaction();
						return { cancel: true };
					}
					return {
						compaction: {
							summary: "compact summary",
							firstKeptEntryId: boundary,
							tokensBefore: event.preparation.tokensBefore,
						},
					};
				});
			},
		]),
	});
	const harness = await createHarness({
		resourceLoader,
		models: [{ id: "preprompt-projection", contextWindow, maxTokens: 4_000 }],
		settings: {
			compaction: {
				enabled: true,
				speculativeEnabled: false,
				idleCompactionEnabled: false,
				keepRecentTokens: 2_000,
				reserveTokens: 20_000,
				reserveScalingEnabled: false,
			},
			retry: { enabled: false },
		},
	});
	harnesses.push(harness);
	const oldId = harness.sessionManager.appendMessage({
		role: "user",
		content: "old context ".repeat(40_000),
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
	const stale = answerWithUsage(contextWindow - 19_000);
	harness.sessionManager.appendMessage(stale);
	harness.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	await harness.session.bindExtensions({});
	return { harness, attempts, stale, oldId };
}

function reportUsageOnProviderTurns(harness: Harness, inputs: number[]): void {
	const streamFunction = harness.agent.streamFunction;
	harness.agent.streamFunction = async (...args) => {
		const input = inputs.shift();
		if (input === undefined) throw new Error("Unexpected provider turn");
		const source = await streamFunction(...args);
		const stream = createAssistantMessageEventStream();
		void (async () => {
			for await (const event of source) {
				if (event.type === "done") event.message.usage = answerWithUsage(input).usage;
				stream.push(event);
			}
			stream.end();
		})().catch((error) => stream.fail(error));
		return stream;
	};
}

function addTail(harness: Harness, text = "extension note"): void {
	harness.sessionManager.appendMessage({
		role: "custom",
		customType: "extension-note",
		content: text,
		display: false,
		timestamp: Date.now(),
	});
	harness.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("#3137: pre-prompt admission uses current projected context", () => {
	it.each([400_000, 500_000])("reaches the provider with an extension tail after compaction at %i", async (window) => {
		// Given: an accepted checkpoint retains a tiny reply with old, over-limit usage.
		const { harness, attempts } = await setup(window);
		await harness.session.compact();
		addTail(harness);
		harness.setResponses([answerWithUsage(1_000)]);

		// When: a real prompt passes both pre-provider admission gates.
		await harness.session.prompt("continue");

		// Then: no second compaction or local refusal prevents the provider call.
		expect(harness.faux.getCallLog()).toHaveLength(1);
		expect(attempts).toEqual(["manual"]);
	});

	it("still admits the same compacted context without an extension tail", async () => {
		const { harness, attempts } = await setup();
		await harness.session.compact();
		harness.setResponses([answerWithUsage(1_000)]);

		await harness.session.prompt("continue");

		expect(harness.faux.getCallLog()).toHaveLength(1);
		expect(attempts).toEqual(["manual"]);
	});

	it("reuses the admission projection while the invalidated-usage branch is unchanged", async () => {
		const { harness } = await setup();
		await harness.session.compact();
		addTail(harness);
		harness.setResponses([answerWithUsage(1_000)]);
		const buildProjection = harness.sessionManager.buildSessionProjection.bind(harness.sessionManager);
		const sampledBranches: ReturnType<typeof harness.sessionManager.getBranch>[] = [];
		const projections = vi.spyOn(harness.sessionManager, "buildSessionProjection").mockImplementation(() => {
			sampledBranches.push(harness.sessionManager.getBranch());
			return buildProjection();
		});

		await harness.session.prompt("continue");

		expect(harness.faux.getCallLog()).toHaveLength(1);
		expect(projections).toHaveBeenCalled();
		expect(new Set(sampledBranches).size).toBe(sampledBranches.length);
	});

	it.each(["fail", "reject", "abort"] as const)("keeps old usage and refuses when compaction %ss", async (outcome) => {
		const { harness } = await setup(400_000, outcome);
		await expect(harness.session.compact()).rejects.toThrow();
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
		expect(
			estimateProjectedContextTokens(
				harness.sessionManager.buildSessionProjection(),
				harness.sessionManager.getBranch(),
			).usageTokens,
		).toBeGreaterThanOrEqual(381_000);
		const callsBefore = harness.faux.getCallLog().length;

		await expect(harness.session.prompt("continue")).rejects.toThrow(/compaction threshold/);

		expect(harness.faux.getCallLog()).toHaveLength(callsBefore);
	});

	it("uses fresh low provider usage after compaction", async () => {
		const { harness, attempts } = await setup();
		await harness.session.compact();
		harness.setResponses([answerWithUsage(1_000), answerWithUsage(1_000)]);
		reportUsageOnProviderTurns(harness, [1_000, 1_000]);

		await harness.session.prompt("first response");
		await harness.session.waitForSettledSessionWork();
		await harness.session.prompt("continue");

		expect(harness.faux.getCallLog()).toHaveLength(2);
		expect(attempts).toEqual(["manual"]);
	});

	it("preserves the first real post-compaction response exemption before the next prompt", async () => {
		const { harness, attempts } = await setup();
		await harness.session.compact();
		harness.setResponses([answerWithUsage(381_000), answerWithUsage(1_000)]);
		reportUsageOnProviderTurns(harness, [381_000, 1_000]);
		await harness.session.prompt("first response still reports old usage");
		await harness.session.waitForSettledSessionWork();

		await harness.session.prompt("continue");

		expect(harness.faux.getCallLog()).toHaveLength(2);
		expect(attempts).toEqual(["manual"]);
	});

	it("refuses fresh high usage from a later real provider response after the exemption is consumed", async () => {
		const { harness, attempts } = await setup();
		await harness.session.compact();
		harness.setResponses([answerWithUsage(1_000), answerWithUsage(381_000)]);
		reportUsageOnProviderTurns(harness, [1_000, 381_000]);
		await harness.session.prompt("consume first-response exemption");
		await harness.session.waitForSettledSessionWork();
		await harness.session.prompt("report current over-limit usage");
		await harness.session.waitForSettledSessionWork();

		await expect(harness.session.prompt("continue")).rejects.toThrow(/compaction threshold/);

		expect(harness.faux.getCallLog()).toHaveLength(2);
		expect(attempts.filter((reason) => reason === "manual")).toHaveLength(1);
	});

	it("retries a provider timeout after accepted compaction without reusing kept usage", async () => {
		const { harness, attempts } = await setup();
		await harness.session.compact();
		harness.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } });
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Request timed out." }),
			answerWithUsage(1_000),
		]);

		await harness.session.prompt("continue");

		expect(harness.eventsOfType("auto_retry_end").filter((event) => !event.success)).toEqual([]);
		expect(harness.faux.getCallLog()).toHaveLength(2);
		expect(harness.session.getLastAssistantText()).toBe("answer");
		expect(harness.eventsOfType("auto_retry_end")).toContainEqual(expect.objectContaining({ success: true }));
		expect(attempts).toEqual(["manual"]);
	});

	it("does not recompact usage invalidated by a context edit in the inline threshold check", async () => {
		const { harness, attempts, oldId } = await setup();
		const leafId = harness.sessionManager.getLeafId();
		for (const entry of harness.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.id !== leafId) {
				harness.sessionManager.appendContextEdit(entry.id, null);
			}
		}
		expect(
			harness.sessionManager.getBranch().some((entry) => entry.type === "context_edit" && entry.targetId === oldId),
		).toBe(true);
		addTail(harness);
		harness.setResponses([answerWithUsage(1_000)]);

		await harness.session.prompt("continue");

		expect(harness.faux.getCallLog()).toHaveLength(1);
		expect(attempts).toEqual([]);
	});

	it("refuses truly oversized post-compaction custom content", async () => {
		const { harness } = await setup();
		await harness.session.compact();
		addTail(harness, "large tail ".repeat(160_000));

		await expect(harness.session.prompt("continue")).rejects.toThrow(/compaction threshold/);

		expect(harness.faux.getCallLog()).toHaveLength(0);
	});

	it("counts turn-local custom messages in final admission after a checkpoint", async () => {
		const { harness } = await setup();
		await harness.session.compact();
		await harness.session.sendCustomMessage(
			{
				customType: "next-turn-note",
				content: "large tail ".repeat(160_000),
				display: false,
			},
			{ deliverAs: "nextTurn" },
		);

		await expect(harness.session.prompt("continue")).rejects.toThrow(/compaction threshold/);

		expect(harness.faux.getCallLog()).toHaveLength(0);
	});
});
