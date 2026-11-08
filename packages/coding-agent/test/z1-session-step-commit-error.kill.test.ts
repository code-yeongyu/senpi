import { HOSTED_REBUILD_DEADLINE_MS } from "@earendil-works/pi-agent-core";
import { normalizeContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isStepCommitError, StepCommitError } from "../../agent/src/step-commit.ts";
import { createReferenceDriver, type ReferenceDriver } from "./egress/harness/reference-driver.ts";
import { constructedSecondCopyErrors } from "./fixtures/step-commit-error-second-copy/index.ts";
import { getMessageText } from "./suite/harness.ts";

// Only the commit-error constructor comes from a second package copy. Agent,
// AgentSession, agent-loop, the classifier, and the reference driver remain real.
vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-agent-core")>();
	const secondCopy = await import("./fixtures/step-commit-error-second-copy/index.ts");
	// A constructor returning a foreign-copy object keeps instanceof false even
	// for a caller holding this exported constructor, not just the direct import.
	function CommitErrorFactory(...args: ConstructorParameters<typeof actual.StepCommitError>) {
		return new secondCopy.SecondCopyStepCommitError(args[0], args[1]);
	}
	return { ...actual, StepCommitError: CommitErrorFactory };
});

// senpi#5841: these are commit/fence fault cases, not a claim of process-KILL coverage.
// The CK22 API has no restart-from-store or generation-bearing ToolHost yet.
describe("CK1s commit fault recovery", () => {
	const drivers: ReferenceDriver[] = [];
	afterEach(() => {
		for (const driver of drivers.splice(0).reverse()) driver.cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
		constructedSecondCopyErrors.length = 0;
	});

	it("S8d contains a second-copy commit error even though instanceof is false", async () => {
		const driver = await createReferenceDriver();
		drivers.push(driver);
		driver.setResponses([fauxAssistantMessage("uncommitted"), fauxAssistantMessage("must not dial")]);
		driver.inject.nextCommit("reject");
		await driver.session.prompt("input");
		const error = constructedSecondCopyErrors.find((candidate) => candidate.code === "storage_unavailable");
		expect(error).toBeDefined();
		expect(error instanceof StepCommitError).toBe(false);
		expect(isStepCommitError(error)).toBe(true);
		await driver.session.prompt("stale retry");
		// streamAssistantResponse synthesizes a terminal error after the refused
		// admission; its commit is refused separately (decision C).
		expect(driver.counters.refusals).toBe(2);
		expect(driver.counters.admissions).toBe(1);
		expect(driver.counters.providerCalls).toBe(1);
		expect(driver.rows.filter((row) => row.kind === "step")).toEqual([]);
		expect(driver.forwarded.slice(driver.latchHistory[0]?.forwardedBefore)).toEqual([]);
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
	});

	it("S12 cancelled-step recovery commits one abort and never redials", async () => {
		const driver = await createReferenceDriver();
		drivers.push(driver);
		driver.setResponses([fauxAssistantMessage("uncommitted"), fauxAssistantMessage("must not dial")]);
		driver.inject.cancelNextStep();
		driver.inject.nextCommit("reject");
		await driver.prompt("input");
		const steps = driver.rows.filter((row) => row.kind === "step");
		expect(driver.rebuilds).toBe(1);
		expect(driver.counters.providerCalls).toBe(1);
		expect(steps).toHaveLength(1);
		expect(steps[0]?.message).toMatchObject({ role: "assistant", stopReason: "aborted", content: [] });
	});

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
			expect(() =>
				old.agent.streamFunction(model, normalizeContext({ messages: [] }), { streamKind: "main" }),
			).toThrowError(/generation/);
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
