/**
 * `move_session` op `status` for an accepted move says whether the landed copy can still be written (senpi#6473). The
 * answer named where the move landed from that move's own entries only. A copy that a later move had released from
 * this host was answered like a session a caller could bind, and binding it was refused `session_moved_away`. The
 * answer now carries the verdict of the rule that refuses those writes, from the same read of the same file.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SessionMovedAwayError } from "../../src/core/session-move/ownership.ts";
import { opened } from "./rpc-inprocess-host-metrics.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { devices, hostAndRelease, importedOnB, landedOnB, move, type Rig } from "./rpc-move-session-support.ts";
import { SESSION_ID } from "./session-move-fixture.ts";

type Fixture = Awaited<ReturnType<typeof devices>>;

const LATER = "move-later";

/** B releases the copy it imported to a third device under a later move, and exports it; nothing imports it. */
async function releasedFromB(b: Rig, fixture: Fixture, onB: string): Promise<void> {
	await hostAndRelease(b, fixture.repoB, onB, LATER, "device-c");
	expect(await move(b, { op: "export", sessionPath: onB, moveId: LATER, target: "device-c" })).toMatchObject({
		success: true,
	});
}

/** What `status` says beside `accepted` once the later move sealed the copy on B. */
const sealedOnB = (fixture: Fixture, onB: string, state: "moving" | "moved") => ({
	...landedOnB(fixture, onB),
	writable: false,
	sealed_by: { move_id: LATER, state, target: "device-c" },
});

describe("move_session status says whether the landed copy can still be written (senpi#6473)", () => {
	it("#given a landed session no later move touched #when status is asked #then it answers writable and names no sealing move", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const onB = await importedOnB(a, b, fixture, "move-w1");

		expect((await move(b, { op: "status", moveId: "move-w1" })).data).toEqual({
			state: "accepted",
			session_path: onB,
			session_id: SESSION_ID,
			cwd: fixture.repoB,
			writable: true,
		});
	});

	it("#given a move accepted here and the landed session then released from here by a later move #when status is asked for the first move #then it answers accepted with the path, not writable, and names the later move and that it is moving", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const onB = await importedOnB(a, b, fixture, "move-w2");
		await releasedFromB(b, fixture, onB);

		const answer = await move(b, { op: "status", moveId: "move-w2" });

		expect(answer.data).toEqual({ state: "accepted", ...sealedOnB(fixture, onB, "moving") });
		// The answer and the refusal are one rule: a write to that copy is refused for the move the answer names.
		const write = () => SessionManager.open(onB).appendMessage({ role: "user", content: "not here", timestamp: 9 });
		expect(write).toThrow(SessionMovedAwayError);
		// A second import of the first move is fenced, and its refusal carries the same fields.
		const bundleDir = join(fixture.agentA, "session-moves", "outgoing", "move-w2");
		const refused = await move(b, { op: "import", bundleDir, cwd: fixture.repoA, from: "device-a" });
		expect(refused).toMatchObject({ success: false, error: "move_fenced" });
		expect(refused.errorData).toEqual({ detail: expect.any(String), ...sealedOnB(fixture, onB, "moving") });
	});

	it("#given the landed session released from here by a later move that named no device #when status is asked for the first move #then sealed_by names the later move with an empty target, the wire's word for a device this host does not know", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const onB = await importedOnB(a, b, fixture, "move-w-no-target");
		const session = opened(
			await b.open("conn-a", { cwd: fixture.repoB, sessionPath: onB, retain_on_disconnect: true }),
			0,
		);
		await b.drop("conn-a");
		await b.router.handle({
			type: "release_session",
			id: "rel",
			sessionId: session.sessionId,
			reason: "move",
			moveId: LATER,
		});
		await b.settle();

		const answer = await move(b, { op: "status", moveId: "move-w-no-target" });

		expect(answer.data).toEqual({
			state: "accepted",
			...landedOnB(fixture, onB),
			writable: false,
			sealed_by: { move_id: LATER, state: "moving", target: "" },
		});
	});

	it("#given that later move finished #when status is asked for the first move #then it answers not writable and that the later move is moved", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const onB = await importedOnB(a, b, fixture, "move-w3");
		await releasedFromB(b, fixture, onB);
		expect(
			await move(b, { op: "finish", sessionPath: onB, moveId: LATER, answer: { state: "accepted" } }),
		).toMatchObject({ success: true, data: { ownership: "moved" } });

		expect((await move(b, { op: "status", moveId: "move-w3" })).data).toEqual({
			state: "accepted",
			...sealedOnB(fixture, onB, "moved"),
		});
	});

	it("#given that later move was declined and the session taken back here #when status is asked for the first move #then it answers writable again", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const onB = await importedOnB(a, b, fixture, "move-w4");
		await releasedFromB(b, fixture, onB);
		expect((await move(b, { op: "status", moveId: "move-w4" })).data).toMatchObject({ writable: false });
		const declined = { state: "declined", reason: "cancelled" };
		expect(await move(b, { op: "finish", sessionPath: onB, moveId: LATER, answer: declined })).toMatchObject({
			success: true,
			data: { ownership: "writable" },
		});

		expect((await move(b, { op: "status", moveId: "move-w4" })).data).toEqual({
			state: "accepted",
			...landedOnB(fixture, onB),
		});
	});

	it("#given the first move's own revoke #when status is asked #then revoked: true as before, not writable, and the sealing move is the first move itself", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const onB = await importedOnB(a, b, fixture, "move-w5");
		expect(await move(b, { op: "revoke", sessionPath: onB, moveId: "move-w5" })).toMatchObject({ success: true });

		expect((await move(b, { op: "status", moveId: "move-w5" })).data).toEqual({
			state: "accepted",
			revoked: true,
			...landedOnB(fixture, onB),
			writable: false,
			sealed_by: { move_id: "move-w5", state: "moved", target: "device-a" },
		});
	});

	// The answer is read from the file, so it holds while the landed session is open on this host, where the ops that
	// change ownership are refused `session_open_here`.
	it("#given the landed session is open on this host #when status is asked, with the move id alone and with the copy's path #then both answer writable, and the session stays open", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const onB = await importedOnB(a, b, fixture, "move-w7");
		const session = opened(await b.open("conn-b", { cwd: fixture.repoB, sessionPath: onB }), 0);

		const byMove = await move(b, { op: "status", moveId: "move-w7" });
		const byPath = await move(b, { op: "status", moveId: "move-w7", sessionPath: onB });

		expect(byMove.data).toEqual({ state: "accepted", ...landedOnB(fixture, onB) });
		expect(byPath.data).toEqual(byMove.data);
		expect((await b.list()).map((row) => row.sessionId)).toEqual([session.sessionId]);
	});

	it("#given the landed session was released from here by a later move and then opened here again #when status is asked for the first move #then it answers not writable and names the later move, while the session is open", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const onB = await importedOnB(a, b, fixture, "move-w8");
		await releasedFromB(b, fixture, onB);
		const session = opened(await b.open("conn-b", { cwd: fixture.repoB, sessionPath: onB }), 0);
		expect((await b.list()).map((row) => row.sessionId)).toEqual([session.sessionId]);

		const byMove = await move(b, { op: "status", moveId: "move-w8" });
		const byPath = await move(b, { op: "status", moveId: "move-w8", sessionPath: onB });

		expect(byMove.data).toEqual({ state: "accepted", ...sealedOnB(fixture, onB, "moving") });
		expect(byPath.data).toEqual(byMove.data);
		expect((await b.list()).map((row) => row.sessionId)).toEqual([session.sessionId]);
	});

	it("#given a status answer with the new fields #when it is passed to finish #then finish accepts it", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const onB = await importedOnB(a, b, fixture, "move-w6");
		await releasedFromB(b, fixture, onB);
		const answer = (await move(b, { op: "status", moveId: "move-w6" })).data;
		expect(answer).toMatchObject({ writable: false, sealed_by: { move_id: LATER } });

		expect(
			await move(a, { op: "finish", sessionPath: fixture.sessionPath, moveId: "move-w6", answer }),
		).toMatchObject({ success: true, data: { ownership: "moved" } });
	});
});
