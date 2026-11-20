/**
 * omo#14428: a follow-up a peer session queued while a run was in flight was parked when that run ended in a
 * provider error, and every later run (a started delivery, a goal continuation, the user's own prompt) settled
 * without taking it, so the session went idle again and again with the delivery still pending in its ledger.
 * A parked queue rejoins the next run: that run's own turn boundary takes it, in order, and writes it even when
 * that run fails too. A rate-limited provider is waited out, so queued follow-ups drain with no new input. A
 * delivery is pending in the ledger exactly while a queue holds it.
 */
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_CONTROL_DELIVERY_TYPE } from "../../../src/core/extensions/types.ts";
import { deliveryIdOf } from "../../../src/core/external-admission.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.useRealTimers();
});

function nextEvent(target: Harness, type: string): Promise<void> {
	return new Promise((resolve) => {
		const unsubscribe = target.session.subscribe((event) => {
			if (event.type !== type) return;
			unsubscribe();
			resolve();
		});
	});
}

function deliveredIds(target: Harness): readonly (string | undefined)[] {
	return target.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom_message" && entry.customType === SESSION_CONTROL_DELIVERY_TYPE
				? [deliveryIdOf({ role: "custom", ...entry, display: entry.display, timestamp: 0 })]
				: [],
		);
}

const REJECTED = "invalid request: context rejected";
const RATE_LIMITED = "HTTP 429: rate_limit_exceeded";

function failure(errorMessage: string): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage("", { stopReason: "error", errorMessage });
}

/** A run whose provider call waits on `release`, then fails with `errorMessage` (by default one no retry owner takes). */
async function failingTurn(
	target: Harness,
	prompt: string,
	errorMessage = REJECTED,
): Promise<{ release: () => void; settled: Promise<void> }> {
	const gate = Promise.withResolvers<void>();
	target.appendResponses([
		async () => {
			await gate.promise;
			return failure(errorMessage);
		},
	]);
	const started = nextEvent(target, "agent_start");
	const settled = target.session.prompt(prompt).catch(() => undefined);
	await started;
	return { release: () => gate.resolve(), settled };
}

describe("omo#14428 parked follow-ups after an error-ended run", () => {
	it("a follow-up parked by an error-ended run is taken by the next started delivery's run, in order", async () => {
		const target = await createHarness({ persistSession: true });
		harnesses.push(target);
		target.setResponses([]);
		const admission = target.session.externalAdmission;

		const turn = await failingTurn(target, "work");
		expect(admission.admit({ delivery_id: "f-1", text: "first queued", deliverAs: "followUp" }).kind).toBe("queued");
		expect(admission.admit({ delivery_id: "f-2", text: "second queued", deliverAs: "followUp" }).kind).toBe("queued");
		turn.release();
		await turn.settled;
		await target.session.waitForIdle();
		expect(admission.list().pending).toEqual(["f-1", "f-2"]);

		target.appendResponses([
			fauxAssistantMessage("ack d-3"),
			fauxAssistantMessage("ack f-1"),
			fauxAssistantMessage("ack f-2"),
		]);
		const idle = nextEvent(target, "agent_idle");
		expect(admission.admit({ delivery_id: "d-3", text: "third, sent while idle", deliverAs: "followUp" }).kind).toBe(
			"started",
		);
		await idle;
		await target.session.waitForIdle();

		expect(deliveredIds(target)).toEqual(["d-3", "f-1", "f-2"]);
		expect(admission.list()).toEqual({ pending: [], emitted: ["d-3", "f-1", "f-2"] });
	});

	it("a follow-up parked by an error-ended run is taken by the user's next prompt's run", async () => {
		const target = await createHarness({ persistSession: true });
		harnesses.push(target);
		target.setResponses([]);
		const admission = target.session.externalAdmission;

		const turn = await failingTurn(target, "work");
		expect(admission.admit({ delivery_id: "f-1", text: "queued", deliverAs: "followUp" }).kind).toBe("queued");
		turn.release();
		await turn.settled;
		await target.session.waitForIdle();

		target.appendResponses([fauxAssistantMessage("ack prompt"), fauxAssistantMessage("ack f-1")]);
		await target.session.prompt("typed into the terminal");
		await target.session.waitForIdle();

		expect(deliveredIds(target)).toEqual(["f-1"]);
		expect(admission.list()).toEqual({ pending: [], emitted: ["f-1"] });
	});

	it("a parked follow-up is written by the next run's first turn even when that run's request fails too", async () => {
		const target = await createHarness({ persistSession: true });
		harnesses.push(target);
		target.setResponses([]);
		const admission = target.session.externalAdmission;

		const turn = await failingTurn(target, "work");
		expect(admission.admit({ delivery_id: "f-1", text: "parked", deliverAs: "followUp" }).kind).toBe("queued");
		turn.release();
		await turn.settled;
		await target.session.waitForIdle();

		target.appendResponses([failure(REJECTED)]);
		const idle = nextEvent(target, "agent_idle");
		expect(admission.admit({ delivery_id: "d-2", text: "sent while idle", deliverAs: "followUp" }).kind).toBe(
			"started",
		);
		await idle;
		await target.session.waitForIdle();

		expect(deliveredIds(target)).toEqual(["d-2", "f-1"]);
		expect(admission.list()).toEqual({ pending: [], emitted: ["d-2", "f-1"] });
		expect(target.session.agent.hasQueuedMessages()).toBe(false);
	});

	// The incident's session had agent_before_settle handlers (goal continuation, stop hooks), which take the post-run
	// queue decision away from the agent core on every agent_end.
	it("with an agent_before_settle handler, a parked follow-up is still written by the next run's first turn when that run fails too", async () => {
		const target = await createHarness({
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", () => undefined);
				},
			],
		});
		harnesses.push(target);
		target.setResponses([]);
		const admission = target.session.externalAdmission;

		const turn = await failingTurn(target, "work");
		expect(admission.admit({ delivery_id: "f-1", text: "parked", deliverAs: "followUp" }).kind).toBe("queued");
		turn.release();
		await turn.settled;
		await target.session.waitForIdle();

		target.appendResponses([failure(REJECTED)]);
		const idle = nextEvent(target, "agent_idle");
		expect(admission.admit({ delivery_id: "d-2", text: "sent while idle", deliverAs: "followUp" }).kind).toBe(
			"started",
		);
		await idle;
		await target.session.waitForIdle();

		expect(deliveredIds(target)).toEqual(["d-2", "f-1"]);
		expect(admission.list()).toEqual({ pending: [], emitted: ["d-2", "f-1"] });
	});

	it("a follow-up queued during a provider-aborted run is written with no new input, never parked", async () => {
		const target = await createHarness({ persistSession: true });
		harnesses.push(target);
		target.setResponses([]);
		const admission = target.session.externalAdmission;

		const gate = Promise.withResolvers<void>();
		target.appendResponses([
			async () => {
				await gate.promise;
				return fauxAssistantMessage("", { stopReason: "aborted", abortSource: "provider" });
			},
		]);
		const started = nextEvent(target, "agent_start");
		const settled = target.session.prompt("work").catch(() => undefined);
		await started;
		expect(admission.admit({ delivery_id: "f-1", text: "queued", deliverAs: "followUp" }).kind).toBe("queued");
		target.appendResponses([fauxAssistantMessage("ack f-1")]);
		gate.resolve();
		await settled;
		await target.session.waitForIdle();

		expect(deliveredIds(target)).toEqual(["f-1"]);
		expect(admission.list()).toEqual({ pending: [], emitted: ["f-1"] });
	});

	it("a rate-limited run keeps draining its follow-ups once the provider answers again, with no new input", async () => {
		vi.useFakeTimers();
		const target = await createHarness({
			persistSession: true,
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1_000 } },
		});
		harnesses.push(target);
		target.setResponses([]);
		const admission = target.session.externalAdmission;
		// Drive exactly the retry owner's announced waits; anything after its last wait stays on the test's clock.
		const retryStarts: number[] = [];
		target.session.subscribe((event) => {
			if (event.type !== "auto_retry_start") return;
			retryStarts.push(event.delayMs);
			queueMicrotask(() => void vi.advanceTimersByTimeAsync(event.delayMs));
		});
		const exhausted = nextEvent(target, "auto_retry_end");

		const turn = await failingTurn(target, "work", RATE_LIMITED);
		target.appendResponses([failure(RATE_LIMITED), failure(RATE_LIMITED)]);
		expect(admission.admit({ delivery_id: "f-1", text: "before the limit", deliverAs: "followUp" }).kind).toBe(
			"queued",
		);
		const retrying = nextEvent(target, "auto_retry_start");
		turn.release();
		await retrying;
		expect(admission.admit({ delivery_id: "f-2", text: "during the limit", deliverAs: "followUp" }).kind).toBe(
			"queued",
		);
		await exhausted;
		expect(retryStarts).toHaveLength(2);
		expect(target.getPendingResponseCount()).toBe(0);
		expect(admission.list().pending).toEqual(["f-1", "f-2"]);

		// Back-to-back deliveries drain as one batch, so the recovered provider answers them in one turn.
		target.appendResponses([fauxAssistantMessage("ack f-1 and f-2")]);
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		await turn.settled;
		await target.session.waitForIdle();

		expect(deliveredIds(target)).toEqual(["f-1", "f-2"]);
		expect(admission.list()).toEqual({ pending: [], emitted: ["f-1", "f-2"] });
		expect(target.getPendingResponseCount()).toBe(0);
	});

	it("a delivery an interrupt takes from behind queued user input leaves the queue with its ledger entry", async () => {
		const target = await createHarness({ persistSession: true });
		harnesses.push(target);
		target.setResponses([]);
		const admission = target.session.externalAdmission;

		const turn = await failingTurn(target, "work");
		await target.session.followUp("typed while busy");
		expect(admission.admit({ delivery_id: "f-1", text: "behind the user", deliverAs: "followUp" }).kind).toBe(
			"queued",
		);
		target.session.takeQueuedDeliveries();
		expect(admission.list().pending).toEqual([]);
		expect(target.session.agent.peekQueuedMessages({ all: true }).map(deliveryIdOf)).toEqual([undefined]);
		turn.release();
		await turn.settled;
		await target.session.waitForIdle();

		// The sender was told the delivery left the session, so it redelivers it: the transcript holds it once.
		target.appendResponses([
			fauxAssistantMessage("ack f-1"),
			fauxAssistantMessage("ack user"),
			fauxAssistantMessage("ack"),
		]);
		const idle = nextEvent(target, "agent_idle");
		expect(admission.admit({ delivery_id: "f-1", text: "behind the user", deliverAs: "followUp" }).kind).toBe(
			"started",
		);
		await idle;
		await target.session.waitForIdle();

		expect(deliveredIds(target)).toEqual(["f-1"]);
		expect(admission.list()).toEqual({ pending: [], emitted: ["f-1"] });
	});
});
