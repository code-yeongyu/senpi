import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { Harness } from "../harness.ts";
import { createBoundLifecycleHarness as createHarness, runToAgentIdle } from "../lifecycle-test-harness.ts";

// senpi#3864, design test 19: the engine decides self-settle when root work seals.
const harnesses: Harness[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});

it.each(["agent", "run"] as const)(
	"seals a standing request independently of its %s completion label",
	async (kind) => {
		// Given an agent request recorded in an admitted root epoch.
		const h = await createHarness({ persistSession: true });
		harnesses.push(h);
		expect(h.session.requestSelfSettle).toBeTypeOf("function");
		let recorded = false;
		const unsubscribe = h.session.subscribe((event) => {
			if (event.type !== "agent_start") return;
			recorded = h.session.requestSelfSettle().recorded;
			if (kind === "run") h.session.lifecycleApi.markRunCompleted({ runId: "workflow:review" });
		});
		h.setResponses([fauxAssistantMessage("Finished.")]);

		// When all root work ends.
		try {
			await runToAgentIdle(h, () => h.session.prompt("Complete the change"));
		} finally {
			unsubscribe();
		}

		// Then the seal, not a label guessed by a client, carries the decision.
		expect(recorded).toBe(true);
		expect(h.session.lifecycle).toMatchObject({
			state: "done",
			persisted: true,
			completion: { kind },
			settleDecision: { decisionId: expect.any(String) },
		});
		expect(h.sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({
				type: "custom",
				customType: "session-lifecycle",
				data: expect.objectContaining({
					state: "done",
					settleDecision: h.session.lifecycle.settleDecision,
				}),
			}),
		);
	},
);

it("keeps the standing request until the final child wake has been consumed", async () => {
	// Given an agent intent in an epoch whose final child still owns work.
	const h = await createHarness({ persistSession: true });
	harnesses.push(h);
	const child = h.session.workObligations.open("task:review", "children");
	const unsubscribe = h.session.subscribe((event) => {
		if (event.type === "agent_start") h.session.requestSelfSettle();
	});
	h.setResponses([fauxAssistantMessage("Waiting for review."), fauxAssistantMessage("Review incorporated.")]);
	await runToAgentIdle(h, () => h.session.prompt("Finish the review."));
	unsubscribe();
	expect(h.session.lifecycle.state).toBe("waiting_children");
	expect(h.session.lifecycle.settleDecision).toBeUndefined();
	const epoch = h.session.lifecycle.epoch;
	const ticket = child.transfer("omo-wake-queue:review").ticket();

	// When the result is consumed and its automatic reply finishes the same epoch.
	await runToAgentIdle(h, () =>
		h.session.sendCustomMessage(
			{ customType: "senpi-task.completion", content: "Review passed.", display: false },
			{ triggerTurn: true, ticket },
		),
	);

	// Then the original request, not a new request in the wake, authorizes one seal.
	expect(h.session.lifecycle).toMatchObject({
		state: "done",
		epoch,
		persisted: true,
		settleDecision: { decisionId: expect.any(String) },
	});
	expect(
		h.events.filter(
			(event) =>
				event.type === "session_lifecycle" && event.lifecycle.state === "done" && event.lifecycle.epoch === epoch,
		),
	).toHaveLength(1);
});

it("never restores an intent overtaken by a human revision whose write failed", async () => {
	// Given a durable request while child custody keeps its epoch unsealed.
	const a = await createHarness({ persistSession: true });
	harnesses.push(a);
	a.session.workObligations.open("task:review", "children");
	const unsubscribe = a.session.subscribe((event) => {
		if (event.type === "agent_start") a.session.requestSelfSettle();
	});
	a.setResponses([fauxAssistantMessage("Waiting for review.")]);
	await runToAgentIdle(a, () => a.session.prompt("Finish after review."));
	unsubscribe();
	const append = a.sessionManager.appendCustomEntry.bind(a.sessionManager);
	const fault = vi.spyOn(a.sessionManager, "appendCustomEntry").mockImplementation((type, data, options) => {
		if (type === "session-lifecycle") throw new Error("Synthetic revision write failure");
		return append(type, data, options);
	});
	await a.session.steer("A human correction.");
	expect(a.session.lifecycle.selfSettleEligible).toBe(false);
	const file = a.sessionManager.getSessionFile();
	if (!file) throw new Error("A persisted session file is required");
	a.session.dispose();
	fault.mockRestore();
	const b = await createHarness({ siblingOf: a, sessionManager: SessionManager.open(file) });
	harnesses.push(b);
	const child = b.session.workObligations.open("task:review", "children");
	const ticket = child.transfer("omo-wake-queue:review").ticket();
	b.setResponses([fauxAssistantMessage("Review incorporated.")]);

	// When automatic work later finishes that recovered epoch.
	await runToAgentIdle(b, () =>
		b.session.sendCustomMessage(
			{ customType: "senpi-task.completion", content: "Review passed.", display: false },
			{ triggerTurn: true, ticket },
		),
	);

	// Then an unsaved intervening human input cannot leave an authoritative intent.
	expect(b.session.lifecycle).toMatchObject({ state: "done", persisted: true, selfSettleEligible: false });
	expect(b.session.lifecycle.settleDecision).toBeUndefined();
});

it("refuses a self-settle request while an unattended hold is live", async () => {
	// Given an unattended reopened session.
	const h = await createHarness({
		sessionStartEvent: { type: "session_start", reason: "resume", attended: false },
	});
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "rpc" });
	expect(h.session.requestSelfSettle).toBeTypeOf("function");

	// When its agent asks to settle.
	const result = h.session.requestSelfSettle();

	// Then the shared hold authority refuses it.
	expect(result).toMatchObject({ recorded: false, reason: "held" });
});

it("keeps a sealed decision unchanged across a reopen", async () => {
	// Given a persisted done epoch with a self-settle decision.
	const a = await createHarness({ persistSession: true });
	harnesses.push(a);
	expect(a.session.requestSelfSettle).toBeTypeOf("function");
	const unsubscribe = a.session.subscribe((event) => {
		if (event.type === "agent_start") a.session.requestSelfSettle();
	});
	a.setResponses([fauxAssistantMessage("Finished.")]);
	await runToAgentIdle(a, () => a.session.prompt("Complete the change"));
	unsubscribe();
	const decision = a.session.lifecycle.settleDecision;
	const completionId = a.session.lifecycle.completionId;
	const file = a.sessionManager.getSessionFile();
	if (!file) throw new Error("A persisted session file is required");
	a.session.dispose();

	// When the engine reopens that transcript and crosses its restore barrier.
	const b = await createHarness({ siblingOf: a, sessionManager: SessionManager.open(file) });
	harnesses.push(b);
	await b.session.bindExtensions({ mode: "rpc" });

	// Then replay neither invents another decision nor another completion.
	expect(b.session.lifecycle).toMatchObject({ completionId, settleDecision: decision, restoring: false });
	expect(
		b.events.filter((event) => event.type === "session_lifecycle" && event.lifecycle.state === "done"),
	).toHaveLength(0);
});

it("invalidates an unsealed self-settle request before the restore barrier opens", async () => {
	// Given a persisted request whose root work remains unsealed under child custody.
	const a = await createHarness({ persistSession: true });
	harnesses.push(a);
	expect(a.session.workObligations).toBeDefined();
	a.session.workObligations.open("task:review", "children");
	const unsubscribe = a.session.subscribe((event) => {
		if (event.type === "agent_start") a.session.requestSelfSettle();
	});
	a.setResponses([fauxAssistantMessage("Waiting for the review.")]);
	await runToAgentIdle(a, () => a.session.prompt("Finish after the review"));
	unsubscribe();
	expect(a.session.lifecycle).toMatchObject({ state: "waiting_children" });
	const file = a.sessionManager.getSessionFile();
	if (!file) throw new Error("A persisted session file is required");
	a.session.dispose();

	// When the engine recovers the unsealed epoch.
	const b = await createHarness({ siblingOf: a, sessionManager: SessionManager.open(file) });
	harnesses.push(b);
	await b.session.bindExtensions({ mode: "rpc" });

	// Then a possibly unsaved intervening human input makes the old request untrustworthy.
	expect(b.session.lifecycle).toMatchObject({ selfSettleEligible: false, restoring: false });
	expect(b.session.requestSelfSettle()).toMatchObject({ recorded: false, reason: "not_eligible" });
});
