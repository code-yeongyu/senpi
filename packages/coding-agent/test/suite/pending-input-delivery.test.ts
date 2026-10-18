import { describe, expect, it } from "vitest";
import { reducePendingInput } from "../../src/core/pending-input.ts";
import { projectPendingInput } from "../../src/core/pending-input-projection.ts";
import { edit, HANDLE, queued, REOPENED, replay, SUBMIT, sending, token, uncertain } from "./pending-input.fixtures.ts";

// senpi#3549: handoff, delivery proof, teardown and Stop. Titles are the plan's transition names (T-ids).

describe("pending input: delivery and custody", () => {
	it("freezes the current version before handing it to the consumer (T05)", () => {
		const decision = reducePendingInput(queued(), { type: "reserve", token: token() });

		expect(decision.next).toMatchObject({ phase: "sending", attempt: token(), attemptCount: 1 });
		expect(decision.effects).toEqual([{ type: "persist" }, { type: "dispatch", token: token() }]);
		expect(projectPendingInput(decision.next ?? queued()).actions).toEqual(["copy"]);
	});

	it("delivers only the committed input and retires its queue handle (T06)", () => {
		const decision = reducePendingInput(sending(), { type: "consumed", token: token() });

		expect(decision.next).toMatchObject({ phase: "delivered", deliveredBy: "consumed" });
		expect(decision.next?.attempt).toBeUndefined();
		expect(projectPendingInput(decision.next ?? queued())).toMatchObject({ pendingDecoration: false, actions: [] });
	});

	it("settles handled commands without a fabricated user entry (T07)", () => {
		const decision = reducePendingInput(queued(), { type: "handled" });

		expect(decision.next).toMatchObject({ phase: "delivered", deliveredBy: "handled" });
		expect(projectPendingInput(decision.next ?? queued()).statusCode).toBe("applied");
	});

	it("fails safely only when the attempt cannot have been consumed (T16)", () => {
		const decision = reducePendingInput(sending(), { type: "refused", token: token(), reason: "target closed" });

		expect(decision.next).toMatchObject({
			phase: "failed",
			failure: { delivery: "not_delivered", reason: "target closed" },
		});
	});

	it("retains ambiguous delivery without enabling resend (T17)", () => {
		const projection = projectPendingInput(uncertain());

		expect(projection).toMatchObject({ state: "failed", statusCode: "delivery_unconfirmed" });
		expect(projection.actions).not.toContain("retry");
		expect(projection.actions).not.toContain("remove");
	});

	it("settles uncertainty from an identity-bearing delivery witness (T18)", () => {
		expect(reducePendingInput(uncertain(), { type: "witnessed" }).next).toMatchObject({ phase: "delivered" });
	});

	it("enables retry only after complete fenced non-delivery evidence (T19)", () => {
		const proven = reducePendingInput(uncertain(), { type: "non_delivery_proven" }).next ?? uncertain();

		expect(proven.failure?.delivery).toBe("not_delivered");
		expect(projectPendingInput(proven).actions).toContain("retry");
	});

	it("preserves pending input across every non-explicit teardown (T20)", () => {
		const current = replay(SUBMIT, edit("e1", 1, "edited"));

		const decision = reducePendingInput(current, { type: "teardown" });

		expect(decision.next).toBe(current);
		expect(decision.effects).toEqual([]);
	});

	it("releases a stale reservation without deleting the input (T21)", () => {
		const decision = reducePendingInput(sending(), { type: "owner_lost", token: token() });

		expect(decision.next).toMatchObject({ phase: "failed", failure: { delivery: "uncertain" }, text: SUBMIT.text });
		expect(decision.next?.attempt).toBeUndefined();
	});

	it("cancels the proven pre-cutoff batch and reports dropped ids (T22)", () => {
		const decision = reducePendingInput(queued(), { type: "cancel", cause: "stop", consumerFenced: false });

		expect(decision.next).toMatchObject({ phase: "removed", removedBy: "stop" });
		expect(decision.effects).toContainEqual({ type: "restore_to_draft", text: SUBMIT.text });
	});

	it("keeps a consumed input out of the Stop restore receipt (T23)", () => {
		const delivered = replay(SUBMIT, { type: "reserve", token: token() }, { type: "consumed", token: token() });

		const decision = reducePendingInput(delivered, { type: "cancel", cause: "stop", consumerFenced: false });

		expect(decision.next).toBe(delivered);
		expect(decision.effects).toEqual([]);
	});

	it("removes an in-flight input only after its consumer is fenced (T24)", () => {
		const decision = reducePendingInput(sending(), { type: "cancel", cause: "stop", consumerFenced: true });

		expect(decision.next).toMatchObject({ phase: "removed", removedBy: "stop" });
		expect(decision.effects).toContainEqual({ type: "restore_to_draft", text: SUBMIT.text });
	});

	it("does not restore text after an unconfirmed drain (T25)", () => {
		const decision = reducePendingInput(sending(), { type: "cancel", cause: "stop", consumerFenced: false });

		expect(decision.next).toMatchObject({ phase: "failed", failure: { delivery: "uncertain" } });
		expect(decision.effects).not.toContainEqual(expect.objectContaining({ type: "restore_to_draft" }));
	});

	it.each([
		{ field: "writerGeneration", stale: token("a-1", { writerGeneration: 2 }) },
		{ field: "lifetimeId", stale: token("a-1", { lifetimeId: "life-2" }) },
		{ field: "ownerId", stale: token("a-1", { ownerId: "owner-2" }) },
		{ field: "attemptId", stale: token("a-2") },
	])("ignores a delivery event whose token differs in $field from the reservation", ({ stale }) => {
		for (const event of [
			{ type: "consumed", token: stale },
			{ type: "refused", token: stale, reason: "x" },
			{ type: "ambiguous", token: stale, reason: "x" },
		] as const) {
			expect(reducePendingInput(sending(), event).next).toMatchObject({ phase: "sending", attempt: token() });
		}
	});

	it("reserves only with a token of the input's current lifetime", () => {
		const decision = reducePendingInput(queued(), { type: "reserve", token: token("a-1", { lifetimeId: "life-0" }) });

		expect(decision.next).toMatchObject({ phase: "queued" });
		expect(decision.effects).toEqual([]);
	});

	it("does not settle an in-flight input from a handled receipt without its token", () => {
		expect(reducePendingInput(sending(), { type: "handled" }).next).toMatchObject({ phase: "sending" });
	});

	it("names the lifetime of each superseded revision, since revisions restart on reopen", () => {
		const edited = replay(SUBMIT, edit("e1", 1, "edited"));
		const rebound = reducePendingInput(edited, { type: "rebind", handle: REOPENED }).next;

		expect(rebound).toMatchObject({ revision: 1, handle: REOPENED });
		expect(rebound?.superseded).toEqual([{ lifetimeId: HANDLE.lifetimeId, revision: 1, text: SUBMIT.text }]);
	});

	it("rebinds lifetime handles without losing text or edited history (T29)", () => {
		const edited = replay(SUBMIT, edit("e1", 1, "edited"));

		const decision = reducePendingInput(edited, { type: "rebind", handle: REOPENED });

		expect(decision.next).toMatchObject({ handle: REOPENED, revision: 1, hasEdits: true, text: "edited" });
		expect(projectPendingInput(decision.next ?? edited).state).toBe("edited");
	});

	it("drops child input only on an explicit cancellation (T31)", () => {
		const decision = reducePendingInput(queued(), { type: "cancel", cause: "child_cancel", consumerFenced: false });

		expect(decision.next).toMatchObject({ phase: "removed", removedBy: "child_cancel" });
		expect(decision.effects).toEqual([{ type: "persist" }]);
	});

	it("ignores replay without reopening terminal input (T32)", () => {
		const delivered = replay(SUBMIT, { type: "reserve", token: token() }, { type: "consumed", token: token() });

		for (const event of [
			{ type: "consumed", token: token() },
			{ type: "witnessed" },
			{ type: "teardown" },
		] as const) {
			expect(reducePendingInput(delivered, event)).toEqual({ next: delivered, effects: [] });
		}
	});

	it("replays one identified withdrawal without another restore effect (T35)", () => {
		const stopped = replay(SUBMIT, { type: "cancel", cause: "stop", consumerFenced: false });

		expect(reducePendingInput(stopped, { type: "cancel", cause: "stop", consumerFenced: false }).effects).toEqual([]);
	});

	it("retains a skipped native prompt without claiming consumption (T49)", () => {
		const decision = reducePendingInput(sending(), {
			type: "refused",
			token: token(),
			reason: "skipped before dispatch",
		});

		expect(decision.next?.failure?.delivery).toBe("not_delivered");
	});

	it("does not infer non-delivery from native cancellation (T50)", () => {
		const decision = reducePendingInput(sending(), {
			type: "ambiguous",
			token: token(),
			reason: "native turn cancelled",
		});

		expect(decision.next?.failure?.delivery).toBe("uncertain");
	});

	it("keeps a witnessed native input delivered after turn cancellation (T51)", () => {
		const delivered = replay(SUBMIT, { type: "reserve", token: token() }, { type: "consumed", token: token() });

		expect(reducePendingInput(delivered, { type: "ambiguous", token: token(), reason: "cancelled" }).next).toBe(
			delivered,
		);
	});

	it("settles only the positively completed native request identity (T52)", () => {
		const other = token("a-other");

		expect(reducePendingInput(sending(), { type: "consumed", token: other }).next?.phase).toBe("sending");
		expect(reducePendingInput(sending(), { type: "consumed", token: token() }).next?.phase).toBe("delivered");
	});

	it("keeps the handle a reopen issued for later changes", () => {
		const reopened = reducePendingInput(queued(), { type: "rebind", handle: REOPENED }).next ?? queued();

		expect(reducePendingInput(reopened, edit("e1", 1, "x", REOPENED)).result?.outcome).toBe("edited");
		expect(reducePendingInput(reopened, edit("e2", 1, "x", HANDLE)).result?.outcome).toBe("stale_handle");
	});
});
