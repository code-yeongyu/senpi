import { describe, expect, it } from "vitest";
import { reducePendingInput } from "../../src/core/pending-input.ts";
import { projectPendingInput } from "../../src/core/pending-input-projection.ts";
import {
	CLIENT_ID,
	edit,
	HANDLE,
	queued,
	REOPENED,
	remove,
	replay,
	SUBMIT,
	sending,
	token,
	uncertain,
	unsent,
} from "./pending-input.fixtures.ts";

// senpi#3549: submission and the user's own changes. Titles are the plan's transition names (T-ids).

describe("pending input: admission and changes", () => {
	it("admits one identified input into durable custody (T01)", () => {
		const decision = reducePendingInput(undefined, SUBMIT);

		expect(decision.next).toMatchObject({
			clientMessageId: CLIENT_ID,
			phase: "queued",
			revision: 1,
			hasEdits: false,
		});
		expect(decision.result?.outcome).toBe("admitted");
		expect(decision.effects).toEqual([{ type: "persist" }]);
	});

	it("retains a definitively rejected input for safe retry (T02)", () => {
		const decision = reducePendingInput(queued(), { type: "reject_before_dispatch", reason: "target unavailable" });

		expect(decision.next).toMatchObject({
			phase: "failed",
			failure: { delivery: "not_delivered" },
			text: SUBMIT.text,
		});
		expect(projectPendingInput(decision.next ?? queued()).actions).toContain("retry");
	});

	it("replays original submission without restoring old edited text (T03)", () => {
		const edited = replay(SUBMIT, edit("e1", 1, "check the error logs"));

		const decision = reducePendingInput(edited, SUBMIT);

		expect(decision.result).toMatchObject({ outcome: "replayed", replayed: true, text: "check the error logs" });
		expect(decision.next).toBe(edited);
		expect(decision.effects).toEqual([]);
	});

	it("rejects conflicting reuse of a submission id (T04)", () => {
		const current = queued();

		const decision = reducePendingInput(current, { ...SUBMIT, fingerprint: "fp-other", text: "something else" });

		expect(decision.result?.outcome).toBe("client_message_id_conflict");
		expect(decision.next).toBe(current);
		expect(decision.effects).toEqual([]);
	});

	it("edits in place and atomically supersedes the old content (T08)", () => {
		const decision = reducePendingInput(queued(), edit("e1", 1, "check the error logs"));

		expect(decision.next).toMatchObject({
			phase: "queued",
			revision: 2,
			hasEdits: true,
			text: "check the error logs",
		});
		expect(decision.next?.superseded).toEqual([{ lifetimeId: "life-1", revision: 1, text: SUBMIT.text }]);
		expect(decision.result).toMatchObject({ outcome: "edited", revision: 2, text: "check the error logs" });
	});

	it("keeps identity order and mode across repeated edits (T09)", () => {
		const twice = replay(SUBMIT, edit("e1", 1, "second"), edit("e2", 2, "third"));

		expect(twice).toMatchObject({
			clientMessageId: CLIENT_ID,
			handle: HANDLE,
			requestedMode: "followUp",
			revision: 3,
		});
		expect(twice.superseded.map((version) => version.revision)).toEqual([1, 2]);
		expect(projectPendingInput(twice).state).toBe("edited");
	});

	it("removes only the revision the user named (T10)", () => {
		const decision = reducePendingInput(queued(), remove("r1", 1));

		expect(decision.next).toMatchObject({ phase: "removed", removedBy: "remove" });
		expect(decision.result?.outcome).toBe("removed");
	});

	it("refuses stale changes without replacing the expected revision (T11)", () => {
		const current = replay(SUBMIT, edit("e1", 1, "newer"));

		const decision = reducePendingInput(current, edit("e2", 1, "stale draft"));

		expect(decision.result).toMatchObject({ outcome: "conflict", currentRevision: 2 });
		expect(decision.next?.text).toBe("newer");
	});

	it("refuses mutation during handoff without claiming delivery (T12)", () => {
		const decision = reducePendingInput(sending(), edit("e1", 1, "too late"));

		expect(decision.result?.outcome).toBe("sending");
		expect(decision.next?.phase).toBe("sending");
	});

	it("uses gone precedence before stale revision conflict (T13)", () => {
		const removed = replay(SUBMIT, remove("r1", 1));

		expect(reducePendingInput(removed, edit("e1", 9, "x")).result?.outcome).toBe("not_found");
		const delivered = replay(SUBMIT, { type: "reserve", token: token() }, { type: "consumed", token: token() });
		expect(reducePendingInput(delivered, remove("r2", 9)).result?.outcome).toBe("already_delivered");
	});

	it("retries the same input with one new attempt and no revision bump (T14)", () => {
		const decision = reducePendingInput(unsent(), { type: "retry", effectId: "t1", handle: HANDLE });

		expect(decision.next).toMatchObject({ phase: "queued", revision: 1, attemptCount: 1 });
		expect(decision.next?.failure).toBeUndefined();
		expect(decision.result?.outcome).toBe("requeued");
	});

	it("blocks retry until non-delivery is proven (T15)", () => {
		expect(reducePendingInput(uncertain(), { type: "retry", effectId: "t1", handle: HANDLE }).result?.outcome).toBe(
			"not_retryable",
		);
		expect(reducePendingInput(queued(), { type: "retry", effectId: "t2", handle: HANDLE }).result?.outcome).toBe(
			"not_retryable",
		);
	});

	it("prevents a superseded version from becoming runnable again (T39)", () => {
		const current = replay(SUBMIT, edit("e1", 1, "current"));

		const reserved = reducePendingInput(current, { type: "reserve", token: token() });

		expect(reserved.next?.text).toBe("current");
		expect(reducePendingInput(current, edit("e2", 1, SUBMIT.text)).result?.outcome).toBe("conflict");
	});

	it("allows discarding a proven-unsent failure without replay (T41)", () => {
		const decision = reducePendingInput(unsent(), remove("r1", 1));

		expect(decision.next?.phase).toBe("removed");
		expect(decision.effects).toEqual([{ type: "persist" }]);
	});

	it("rejects stale lifetime handles and foreign scope completions (T42)", () => {
		const reopened = reducePendingInput(queued(), { type: "rebind", handle: REOPENED }).next ?? queued();

		expect(reducePendingInput(reopened, edit("e1", 1, "x", HANDLE)).result?.outcome).toBe("stale_handle");
		expect(
			reducePendingInput(sending(), { type: "consumed", token: token("a-1", { ownerId: "intruder" }) }).next?.phase,
		).toBe("sending");
	});

	it("replays the complete original effect answer across reopen (T43)", () => {
		const edited = replay(SUBMIT, edit("e1", 1, "fixed"));
		const reopened = reducePendingInput(edited, { type: "rebind", handle: REOPENED }).next ?? edited;

		const again = reducePendingInput(reopened, edit("e1", 1, "fixed"));

		expect(again.result).toMatchObject({
			outcome: "edited",
			revision: 2,
			text: "fixed",
			lifetimeId: HANDLE.lifetimeId,
			replayed: true,
		});
		expect(reducePendingInput(reopened, edit("e1", 1, "different")).result?.outcome).toBe("effect_id_conflict");
	});
});
