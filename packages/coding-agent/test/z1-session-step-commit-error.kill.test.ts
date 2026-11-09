import { HOSTED_REBUILD_DEADLINE_MS } from "@earendil-works/pi-agent-core";
import { normalizeContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isStepCommitError, StepCommitError } from "../../agent/src/step-commit.ts";
import { createReferenceDriver, type ReferenceDriver } from "./egress/harness/reference-driver.ts";
import { heldResponse } from "./fixtures/faux-provider/step-commit.ts";
import { recoveryTool } from "./fixtures/faux-provider/tool-recovery.ts";
import { SecondCopyStepCommitError } from "./fixtures/step-commit-error-second-copy/index.ts";
import { getMessageText } from "./suite/harness.ts";

// senpi#5841: eviction drives CK22's in-process fault boundary, not an OS process kill.
describe("CK1s commit fault recovery", () => {
	const drivers: ReferenceDriver[] = [];
	afterEach(() => {
		for (const driver of drivers.splice(0).reverse()) driver.cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("S8a resumes a committed tool once and fences its discarded dispatch", async () => {
		const probe = recoveryTool();
		const driver = await createReferenceDriver({ tools: [probe.tool] });
		drivers.push(driver);
		driver.setResponses([
			fauxAssistantMessage([fauxToolCall("record", {}, { id: "effect-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("completed"),
		]);
		const hold = driver.inject.pauseNextTool();
		const prompt = driver.prompt("input");
		await hold.reached;
		expect(driver.rows.filter((row) => row.kind === "step")).toHaveLength(1);
		expect(probe.effects).toEqual([]);
		await driver.evict();
		await prompt;
		expect(probe.effects, "discarded instance must produce no tool effect").toEqual([]);
		expect(driver.toolLedger).toEqual([
			{ toolName: "record", toolCallId: "effect-1", generation: 1, outcome: "killed" },
		]);
		await driver.resume();
		await driver.settle();
		expect(probe.effects, "committed pending tool runs exactly once").toEqual(["effect-1"]);
		expect(driver.toolLedger).toEqual([
			{ toolName: "record", toolCallId: "effect-1", generation: 1, outcome: "killed" },
			{ toolName: "record", toolCallId: "effect-1", generation: 2, outcome: "ran" },
		]);
		expect(driver.counters.providerCalls).toBe(2);
		expect(driver.callLog()[1]?.context.messages.filter((message) => message.role === "toolResult")).toMatchObject([
			{ toolCallId: "effect-1", content: [{ type: "text", text: "recorded" }] },
		]);
		await driver.evict();
		await driver.resume();
		expect(probe.effects).toEqual(["effect-1"]);
		expect(driver.counters.providerCalls).toBe(2);
	});

	it("S8b eviction between rejection and rebuild replays the input once", async () => {
		const driver = await createReferenceDriver();
		drivers.push(driver);
		driver.setResponses([fauxAssistantMessage("uncommitted"), fauxAssistantMessage("replayed")]);
		driver.inject.nextCommit("reject");
		const build = driver.inject.holdNextHarnessBuild();
		const prompt = driver.prompt("input");
		await build.reached;
		expect(driver.latched).toBe(true);
		expect(driver.counters.providerCalls).toBe(1);
		await driver.evict();
		build.release();
		await prompt;
		await driver.resume();
		await driver.settle();
		expect(driver.counters.providerCalls, "one initial call and exactly one replay").toBe(2);
		expect(driver.counters.admissions).toBe(2);
		expect(driver.rows.map((row) => [row.kind, getMessageText(row.message)])).toEqual([
			["input", "input"],
			["step", "replayed"],
		]);
		expect(driver.callLog().map((call) => call.context.messages.map(getMessageText))).toEqual([["input"], ["input"]]);
		expect(driver.forwarded.filter((entry) => entry.generation === 2)).toEqual([]);
	});

	it("S8a refuses discarded dispatch before invoking a signal-insensitive tool", async () => {
		const probe = recoveryTool();
		const driver = await createReferenceDriver({
			tools: [{ ...probe.tool, execute: (id, params) => probe.tool.execute(id, params) }],
		});
		drivers.push(driver);
		driver.setResponses([
			fauxAssistantMessage([fauxToolCall("record", {}, { id: "uncooperative" })], { stopReason: "toolUse" }),
		]);
		const hold = driver.inject.pauseNextTool();
		const prompt = driver.prompt("input");
		await hold.reached;
		await driver.evict();
		await prompt;
		// Section 15.1(d) requires dispatch refusal, independently of tool abort cooperation.
		expect(probe.effects, "discarded generation must be refused before invoking the tool").toEqual([]);
	});

	it("S8a partially dispatched batch resumes only the unrun tool from the exactly-once ledger", async () => {
		const probe = recoveryTool();
		const firstDone = Promise.withResolvers<void>();
		let hold: ReturnType<ReferenceDriver["inject"]["pauseNextTool"]> | undefined;
		const driver = await createReferenceDriver({
			tools: [
				{
					...probe.tool,
					executionMode: "sequential",
					execute: async (id, params, signal) => {
						const result = await probe.tool.execute(id, params, signal);
						if (id === "already-ran" && !hold) {
							hold = driver.inject.pauseNextTool();
							firstDone.resolve();
						}
						return result;
					},
				},
			],
		});
		drivers.push(driver);
		driver.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("record", {}, { id: "already-ran" }), fauxToolCall("record", {}, { id: "pending" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("completed"),
		]);
		const prompt = driver.prompt("input");
		await firstDone.promise;
		if (!hold) throw new Error("First tool must arm the second dispatch gate");
		await hold.reached;
		await driver.evict();
		await prompt;
		expect(probe.effects).toEqual(["already-ran"]);
		await driver.resume();
		await driver.settle();
		expect(probe.effects, "ledger must prevent replaying the completed tool").toEqual(["already-ran", "pending"]);
		expect(driver.toolLedger.filter((entry) => entry.outcome === "ran").map((entry) => entry.toolCallId)).toEqual([
			"already-ran",
			"pending",
		]);
	});

	it("S12 active tool stop aborts dispatch once and never redials", async () => {
		const probe = recoveryTool();
		const driver = await createReferenceDriver({ tools: [probe.tool] });
		drivers.push(driver);
		driver.setResponses([
			fauxAssistantMessage([fauxToolCall("record", {}, { id: "stopped" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("must not dial"),
		]);
		const hold = driver.inject.pauseNextTool();
		const prompt = driver.prompt("input");
		await hold.reached;
		expect(driver.latched).toBe(false);
		expect(driver.stop()).toBe("cancelled-active-step");
		await prompt;
		await driver.settle();
		expect(driver.counters.providerCalls, "active tool stop must not redial").toBe(1);
		expect(probe.aborted).toEqual(["stopped"]);
		expect(probe.effects).toEqual([]);
		expect(driver.toolLedger).toEqual([
			{ toolName: "record", toolCallId: "stopped", generation: 1, outcome: "killed" },
		]);
		expect(driver.stops).toEqual([{ stepId: "step-1", while: "active" }]);
		expect(driver.stop()).toBe("nothing-latched");
	});

	it.each([
		{ rejectCommit: false, name: "S12 active stop commits one abort without redial after eviction" },
		{ rejectCommit: true, name: "S12 active stop survives the aborted step's commit rejection" },
	])("$name", async ({ rejectCommit }) => {
		const driver = await createReferenceDriver();
		drivers.push(driver);
		const response = heldResponse(fauxAssistantMessage("must not commit"));
		driver.setResponses([response.response, fauxAssistantMessage("must not dial")]);
		if (rejectCommit) driver.inject.nextCommit("reject");
		const prompt = driver.prompt("input");
		await response.entered;
		expect(driver.latched).toBe(false);
		expect(driver.stop()).toBe("cancelled-active-step");
		response.release();
		await prompt;
		await driver.settle();
		await driver.evict();
		await driver.resume();
		expect(driver.counters.providerCalls, "active stop must not redial").toBe(1);
		expect(driver.stops).toEqual([{ stepId: "active", while: "active" }]);
		const steps = driver.rows.filter((row) => row.kind === "step");
		expect(steps.map((row) => row.message)).toMatchObject([{ role: "assistant", stopReason: "aborted" }]);
		expect(steps.map((row) => getMessageText(row.message))).toEqual([""]);
		expect(driver.stop()).toBe("nothing-latched");
	});

	it("S8d classifies an injected second-copy commit error by brand and contains stale effects", async () => {
		const driver = await createReferenceDriver();
		drivers.push(driver);
		driver.setResponses([fauxAssistantMessage("uncommitted"), fauxAssistantMessage("must not dial")]);
		const error = new SecondCopyStepCommitError("foreign-step", "fenced");
		expect(error instanceof StepCommitError).toBe(false);
		expect(isStepCommitError(error)).toBe(true);
		driver.inject.nextCommitError(error);
		const build = driver.inject.holdNextHarnessBuild();
		const old = driver.session;
		await old.prompt("input");
		expect(driver.classifications).toEqual([{ stepId: "step-1", error, kind: "step-commit-error", code: "fenced" }]);
		expect(driver.classifications[0]?.error).toBe(error);
		expect(driver.latchHistory).toMatchObject([{ stepId: "step-1", code: "fenced", generationAfter: 2 }]);
		await old.prompt("stale retry");
		// streamAssistantResponse synthesizes a terminal error after the refused
		// admission; its commit is refused separately (decision C).
		expect(driver.counters.refusals).toBe(2);
		expect(driver.counters.admissions).toBe(1);
		expect(driver.counters.providerCalls).toBe(1);
		expect(driver.rows.filter((row) => row.kind === "step")).toEqual([]);
		expect(driver.forwarded.slice(driver.latchHistory[0]?.forwardedBefore)).toEqual([]);
		build.release();
		await driver.whenRebuilt();
	});

	it("S6a dispose cancels a real pending retry timer before another admission", async () => {
		const driver = await createReferenceDriver({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1000 } },
		});
		drivers.push(driver);
		driver.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("must not dial"),
		]);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const retry = Promise.withResolvers<void>();
		driver.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retry.resolve();
		});
		const prompt = driver.session.prompt("input");
		await retry.promise;
		await vi.advanceTimersByTimeAsync(0);
		expect(vi.getTimerCount()).toBeGreaterThan(0);
		driver.session.dispose();
		await vi.advanceTimersByTimeAsync(0);
		expect(vi.getTimerCount()).toBe(0);
		await prompt;
		expect(driver.counters.admissions).toBe(1);
		expect(driver.counters.providerCalls).toBe(1);
	});

	it("S6b a leaked continuation timer firing after rebuild cannot admit the discarded instance", async () => {
		const driver = await createReferenceDriver();
		drivers.push(driver);
		driver.setResponses([
			fauxAssistantMessage("uncommitted"),
			fauxAssistantMessage("recovered"),
			fauxAssistantMessage("must not dial"),
		]);
		const old = driver.session;
		const dispose = vi.spyOn(old, "dispose").mockImplementation(() => {});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		// Deliberately leaked timer: the callback owns the old instance, as a
		// background extension does. Containment must not depend on disposal.
		const timer = Promise.withResolvers<void>();
		const handle = setTimeout(() => {
			old.prompt("late timer").then(timer.resolve, timer.reject);
		}, 1000);
		driver.inject.nextCommit("reject");
		try {
			await driver.prompt("input");
			const before = driver.counters;
			const rows = [...driver.rows];
			const forwarded = [...driver.forwarded];
			await vi.advanceTimersByTimeAsync(1000);
			await timer.promise;
			expect(driver.counters.refusals).toBe(before.refusals + 2);
			expect(driver.counters.admissions).toBe(before.admissions);
			expect(driver.counters.providerCalls).toBe(before.providerCalls);
			expect(driver.rows).toEqual(rows);
			expect(driver.forwarded).toEqual(forwarded);
		} finally {
			clearTimeout(handle);
			dispose.mockRestore();
		}
	});

	it("S14 a commit failure inside an automatic retry continuation latches before any later admission", async () => {
		const driver = await createReferenceDriver({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1000 } },
		});
		drivers.push(driver);
		driver.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("retry uncommitted"),
			fauxAssistantMessage("must not dial"),
		]);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const retry = Promise.withResolvers<number>();
		driver.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retry.resolve(event.delayMs);
		});
		const old = driver.session;
		const prompt = old.prompt("input");
		const delay = await retry.promise;
		driver.inject.nextCommit("reject");
		await vi.advanceTimersByTimeAsync(delay);
		await prompt;
		expect(driver.latchHistory).toMatchObject([{ code: "storage_unavailable", generationAfter: 2 }]);
		const before = driver.counters;
		await old.prompt("late retry");
		expect(driver.counters.refusals).toBe(before.refusals + 2);
		expect(driver.counters.admissions).toBe(2);
		expect(driver.counters.providerCalls).toBe(2);
		expect(driver.rows.filter((row) => row.kind === "step").map((row) => getMessageText(row.message))).toEqual([""]);
		expect(driver.forwarded.slice(driver.latchHistory[0]?.forwardedBefore)).toEqual([]);
	});

	it("S14 a scheduled continueWithQueuedMessages commit failure fences its next drain", async () => {
		const driver = await createReferenceDriver();
		drivers.push(driver);
		driver.setResponses([fauxAssistantMessage("committed"), fauxAssistantMessage("queued uncommitted")]);
		await driver.prompt("input");
		await driver.followUp("queued input");
		driver.inject.nextCommit("reject");
		const build = driver.inject.holdNextHarnessBuild();
		const old = driver.session;
		// The hosted caller schedules the public Agent continuation. This does not
		// claim coverage of AgentSession's compaction-dependent scheduling path.
		await Promise.resolve().then(() => old.agent.continueWithQueuedMessages());
		expect(driver.latched).toBe(true);
		expect(driver.latchHistory).toMatchObject([{ code: "storage_unavailable", generationAfter: 2 }]);
		const before = driver.counters;
		await old.prompt("late drain");
		expect(driver.counters.refusals).toBe(before.refusals + 2);
		expect(driver.counters.admissions).toBe(2);
		expect(driver.counters.providerCalls).toBe(2);
		expect(driver.rows.map((row) => getMessageText(row.message))).toEqual(["input", "committed", "queued input"]);
		expect(driver.forwarded.slice(driver.latchHistory[0]?.forwardedBefore)).toEqual([]);
		build.release();
		await driver.whenRebuilt();
	});

	it.each(["ambiguous-landed", "ambiguous-lost"] as const)(
		"S8c %s yields exactly one committed answer and refuses a lost write landing late",
		async (fault) => {
			const driver = await createReferenceDriver();
			drivers.push(driver);
			driver.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("redial")]);
			driver.inject.nextCommit(fault);
			await driver.prompt("input");
			const lost = fault === "ambiguous-lost";
			expect(driver.deliverLateLanding()).toBe(lost ? "refused" : "none");
			expect(driver.counters.refusals).toBe(lost ? 1 : 0);
			expect(driver.counters.providerCalls).toBe(lost ? 2 : 1);
			expect(driver.rebuilds).toBe(lost ? 1 : 0);
			expect(driver.rows.filter((row) => row.kind === "step").map((row) => getMessageText(row.message))).toEqual([
				lost ? "redial" : "first",
			]);
			// LOW-2: the next real session request must use exactly the resolved
			// answer, not the lost in-memory attempt or a duplicated durable answer.
			driver.setResponses([fauxAssistantMessage("next answer")]);
			await driver.prompt("next question");
			expect(driver.callLog().at(-1)?.context.messages.map(getMessageText)).toEqual([
				"input",
				lost ? "redial" : "first",
				"next question",
			]);
		},
	);

	it("S8 committed-path precondition uses the other admission's row without redial", async () => {
		const driver = await createReferenceDriver();
		drivers.push(driver);
		driver.setResponses([fauxAssistantMessage("uncommitted")]);
		driver.inject.nextCommit("already-committed", fauxAssistantMessage("other admission"));
		await driver.prompt("input");
		expect(driver.latchHistory.map((entry) => entry.code)).toEqual(["already_committed"]);
		expect(driver.session.messages.map(getMessageText)).toEqual(["input", "other admission"]);
		expect(driver.counters.providerCalls).toBe(1);
		driver.setResponses([fauxAssistantMessage("next answer")]);
		await driver.prompt("next question");
		expect(driver.callLog().at(-1)?.context.messages.map(getMessageText)).toEqual([
			"input",
			"other admission",
			"next question",
		]);
	});

	it.each(["pre-cancelled", "stop-while-latched"] as const)(
		"S12 %s commits one abort, never redials, and removes the failed answer from the next session request",
		async (cancellation) => {
			const driver = await createReferenceDriver();
			drivers.push(driver);
			driver.setResponses([fauxAssistantMessage("uncommitted"), fauxAssistantMessage("must not dial")]);
			if (cancellation === "pre-cancelled") driver.inject.cancelNextStep();
			driver.inject.nextCommit("reject");
			driver.inject.slowRebuildStoreRead(1);
			const reached = driver.rebuildStoreReadStarted();
			const prompt = driver.prompt("input");
			await reached;
			expect(driver.latched).toBe(true);
			expect(driver.counters.providerCalls).toBe(1);
			if (cancellation === "stop-while-latched") {
				expect(driver.stop()).toBe("cancelled-latched-step");
				expect(driver.stops).toEqual([{ stepId: "step-1", while: "latched" }]);
			}
			driver.clock.advance(1);
			await prompt;
			const steps = driver.rows.filter((row) => row.kind === "step");
			expect(driver.rebuilds).toBe(1);
			expect(driver.counters.providerCalls).toBe(1);
			expect(steps).toHaveLength(1);
			expect(steps[0]?.message).toMatchObject({ role: "assistant", stopReason: "aborted", content: [] });
			expect(driver.session.messages.map(getMessageText)).toEqual(["input", ""]);
			expect(driver.stop()).toBe("nothing-latched");
			driver.setResponses([fauxAssistantMessage("next answer")]);
			await driver.prompt("next question");
			expect(driver.callLog().at(-1)?.context.messages.map(getMessageText)).toEqual(["input", "next question"]);
		},
	);

	it.each([HOSTED_REBUILD_DEADLINE_MS - 1, HOSTED_REBUILD_DEADLINE_MS + 1])(
		"S11 store-read boundary at %i ms preserves containment until rebuild",
		async (delay) => {
			const driver = await createReferenceDriver();
			drivers.push(driver);
			driver.setResponses([fauxAssistantMessage("uncommitted"), fauxAssistantMessage("recovered")]);
			driver.inject.nextCommit("reject");
			driver.inject.slowRebuildStoreRead(delay);
			const reached = driver.rebuildStoreReadStarted();
			const prompt = driver.prompt("input");
			await reached;
			const old = driver.session;
			const model = old.model;
			if (!model) throw new Error("The faux session has no model");
			expect(driver.latched).toBe(true);
			await expect(
				old.agent.streamFunction(model, normalizeContext({ messages: [] }), { streamKind: "main" }),
			).rejects.toThrowError(/generation/);
			expect(driver.counters.providerCalls).toBe(1);
			driver.clock.advance(delay);
			await prompt;
			expect(driver.counters.rebuildDeadlineMisses).toBe(delay > HOSTED_REBUILD_DEADLINE_MS ? 1 : 0);
			expect(driver.rebuilds).toBe(1);
			expect(driver.counters.providerCalls).toBe(2);
			expect(driver.session.messages.map(getMessageText)).toEqual(["input", "recovered"]);
		},
	);
});
