import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/index.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { createHarness, getAssistantTexts, type Harness } from "../harness.ts";

const STALE_USAGE_TOTAL_TOKENS = 127_500;
const STALE_USAGE_INPUT_TOKENS = 127_300;
const STALE_USAGE_OUTPUT_TOKENS = 200;

function zeroUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function staleHighUsage() {
	return {
		input: STALE_USAGE_INPUT_TOKENS,
		output: STALE_USAGE_OUTPUT_TOKENS,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: STALE_USAGE_TOTAL_TOKENS,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function getRunAutoCompaction(harness: Harness) {
	const runAutoCompaction = Reflect.get(harness.session, "_runAutoCompaction");
	if (typeof runAutoCompaction !== "function") {
		throw new Error("Expected AgentSession._runAutoCompaction");
	}
	return (reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> =>
		Promise.resolve(runAutoCompaction.call(harness.session, reason, willRetry));
}

function getClearAllQueues() {
	const clearAllQueues = Reflect.get(InteractiveMode.prototype, "clearAllQueues");
	if (typeof clearAllQueues !== "function") throw new Error("Expected InteractiveMode.clearAllQueues");
	return (context: object): { steering: string[]; followUp: string[] } => clearAllQueues.call(context);
}

function getAbortAndFireQueuedMessages() {
	const abortAndFire = Reflect.get(InteractiveMode.prototype, "abortAndFireQueuedMessages");
	if (typeof abortAndFire !== "function") throw new Error("Expected InteractiveMode.abortAndFireQueuedMessages");
	return (context: object): Promise<number> => Promise.resolve(abortAndFire.call(context));
}

function createPostCompactionExemptionHarness() {
	return createHarness({
		models: [{ id: "post-compaction-stale-usage", contextWindow: 128_000, maxTokens: 64 }],
		settings: { compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 } },
		extensionFactories: [
			(pi: ExtensionAPI) => {
				pi.on("session_before_compact", (event) => ({
					compaction: {
						summary: "accepted post-compaction exemption summary",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				}));
			},
		],
	});
}

describe("post-compaction queued continuation exemption", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("lets the queued continuation reach the provider after stale-usage compaction without recompacting", async () => {
		// RED 2: the accepted auto compaction arms the post-compaction exemption
		// exactly once. The first ordinary response still reports the stale high
		// provider usage from before the compaction, and its agent_end queues
		// steer/followUp work. The exemption must be shared by the synchronous
		// drain classification (queued drain is not suppressed) and the async
		// _checkCompaction (no second compaction, no RequiredCompactionError):
		// the queued continuation reaches the provider once.
		const harness = await createPostCompactionExemptionHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("seed response")]);
		await harness.session.prompt("seed exemption context ".repeat(40));

		await getRunAutoCompaction(harness)("threshold", false);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({ reason: "threshold", accepted: true }),
		]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		harness.events.length = 0;

		harness.setResponses([
			{
				...fauxAssistantMessage("ordinary post-compaction response"),
				usage: staleHighUsage(),
			},
			fauxAssistantMessage("queued steer handled"),
			fauxAssistantMessage("queued follow-up handled"),
		]);
		const prompt = harness.session.prompt("first ordinary prompt after compaction");
		await harness.session.waitForIdle();
		// agent_end must see the queued work before the exemption is consumed so
		// the drain classification under test decides its fate.
		await harness.session.prompt("queued steer after stale usage", { streamingBehavior: "steer" });
		await harness.session.followUp("queued follow-up after stale usage");
		await prompt;
		await harness.session.waitForIdle();
		await harness.session.waitForSettledSessionWork();

		// One accepted compaction from the setup and exactly one assistant
		// appended per provider call: the exempted response never triggers a
		// second compaction, a duplicate append, or a duplicate terminal event.
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(0);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(getAssistantTexts(harness).filter((text) => text === "ordinary post-compaction response")).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(4);
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(harness.session.isCompacting).toBe(false);
	});

	it("consumes the exemption exactly once when a stale-usage agent_end queues continuation", async () => {
		// Companion boundary for RED 2: after the exempted stale-usage response,
		// its queued follow-up drains to the provider with zero usage. That
		// follow-up's agent_end must not consume a second exemption: the
		// estimate path sees only kept pre-compaction usage plus the exempted
		// (already before-boundary) response, so no further compaction runs.
		const harness = await createPostCompactionExemptionHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("seed response")]);
		await harness.session.prompt("seed single-exemption context ".repeat(40));

		await getRunAutoCompaction(harness)("threshold", false);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({ reason: "threshold", accepted: true }),
		]);
		harness.events.length = 0;

		harness.setResponses([
			{
				...fauxAssistantMessage("stale usage response"),
				usage: staleHighUsage(),
			},
			{ ...fauxAssistantMessage("zero-usage follow-up handled"), usage: zeroUsage() },
		]);
		const prompt = harness.session.prompt("first single-exemption prompt after compaction");
		await harness.session.waitForIdle();
		await harness.session.followUp("single follow-up after stale usage");
		await prompt;
		await harness.session.waitForIdle();
		await harness.session.waitForSettledSessionWork();

		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(0);
		expect(harness.faux.state.callCount).toBe(3);
		expect(getAssistantTexts(harness)).toEqual([
			"seed response",
			"stale usage response",
			"zero-usage follow-up handled",
		]);
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(harness.session.isCompacting).toBe(false);
	});

	it.each([
		{
			label: "the public session queue clear",
			clear: (harness: Harness) => harness.session.clearQueue(),
		},
		{
			label: "the InteractiveMode queue clear",
			clear: (harness: Harness) =>
				getClearAllQueues()({
					compactionQueuedMessages: [],
					compactionInFlightMessages: [],
					compactionTransferAbortControllers: new Map(),
					session: harness.session,
				}),
		},
	])("does not resurrect deferred post-compaction work after $label", async ({ clear }) => {
		const steerMarker = "clear deferred post-compaction steer";
		const followUpMarker = "clear deferred post-compaction follow-up";
		const harness = await createPostCompactionExemptionHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("seed response")]);
		await harness.session.prompt("seed clear-deferred context ".repeat(40));
		await getRunAutoCompaction(harness)("threshold", false);
		harness.events.length = 0;

		harness.setResponses([
			{
				...fauxAssistantMessage("stale response before queue clear"),
				usage: staleHighUsage(),
			},
			fauxAssistantMessage("deferred steer must not reach provider"),
			fauxAssistantMessage("deferred follow-up must not reach provider"),
		]);
		const prompt = harness.session.prompt("first prompt after accepted compaction");
		await harness.session.waitForIdle();
		await harness.session.prompt(steerMarker, { streamingBehavior: "steer" });
		await harness.session.followUp(followUpMarker);

		const cleared = clear(harness);
		expect(cleared).toEqual({ steering: [steerMarker], followUp: [followUpMarker] });
		expect(cleared.steering.filter((text) => text === steerMarker)).toHaveLength(1);
		expect(cleared.followUp.filter((text) => text === followUpMarker)).toHaveLength(1);

		await prompt;
		await harness.session.waitForSettledSessionWork();

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(getAssistantTexts(harness)).not.toContain("deferred steer must not reach provider");
		expect(getAssistantTexts(harness)).not.toContain("deferred follow-up must not reach provider");
	});

	it("does not resurrect deferred work after InteractiveMode abort clears the visible queue", async () => {
		const steerMarker = "abort deferred post-compaction steer";
		const followUpMarker = "abort deferred post-compaction follow-up";
		const harness = await createPostCompactionExemptionHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("seed response")]);
		await harness.session.prompt("seed abort-deferred context ".repeat(40));
		await getRunAutoCompaction(harness)("threshold", false);
		harness.setResponses([
			{ ...fauxAssistantMessage("stale response before abort"), usage: staleHighUsage() },
			fauxAssistantMessage("aborted deferred steer must not reach provider"),
			fauxAssistantMessage("aborted deferred follow-up must not reach provider"),
		]);
		const prompt = harness.session.prompt("first prompt before queue abort");
		await harness.session.waitForIdle();
		await harness.session.prompt(steerMarker, { streamingBehavior: "steer" });
		await harness.session.followUp(followUpMarker);

		const setText = vi.fn<(text: string) => void>();
		const context = {
			compactionQueuedMessages: [],
			compactionInFlightMessages: [],
			compactionTransferAbortControllers: new Map(),
			session: harness.session,
			updatePendingMessagesDisplay: vi.fn(),
			editor: { getText: () => "draft", setText },
			clearAllQueues: () => getClearAllQueues()(context),
		};
		const restored = await getAbortAndFireQueuedMessages()(context);
		expect(restored).toBe(2);
		expect(setText).toHaveBeenCalledWith(`${steerMarker}\n\n${followUpMarker}\n\ndraft`);

		await prompt;
		await harness.session.waitForSettledSessionWork();
		expect(harness.faux.state.callCount).toBe(2);
		expect(getAssistantTexts(harness)).not.toContain("aborted deferred steer must not reach provider");
		expect(getAssistantTexts(harness)).not.toContain("aborted deferred follow-up must not reach provider");
	});
});
