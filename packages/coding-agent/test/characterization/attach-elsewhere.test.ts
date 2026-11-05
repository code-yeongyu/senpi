import { describe, expect, it } from "vitest";
import { attachmentRig } from "../suite/rpc-attachment-support.ts";
import { opened } from "../suite/rpc-inprocess-host-metrics.ts";

/**
 * X15 (Z1.p-S37): today's behaviour when a session one client already holds is opened again from a
 * second client on the same host. The second `open_session` for the same file joins the live runtime:
 * same handle, `attached: true`, one more attachment, and the first client keeps its hold untouched.
 */
type WireRecord = Record<string, unknown>;

function lifecycleRecords(records: readonly WireRecord[]): WireRecord[] {
	return records.filter(
		(record) =>
			record.type === "session_closed" ||
			record.type === "session_parked" ||
			record.type === "session_resumed" ||
			record.type === "response",
	);
}

describe("X15: an already-attached session opened elsewhere on one machine", () => {
	it("joins the live session for the second client and leaves the first client's hold alone", async () => {
		await using rig = await attachmentRig();
		const ref = await rig.session();
		const status = await rig.send("observer", { id: "sub", type: "subscribe_sessions" });
		expect(status).toMatchObject({ success: true });
		const beforeFirst = rig.recordsFor("caller").length;
		const beforeObserver = rig.recordsFor("observer").length;

		const reply = await rig.open("elsewhere", { cwd: rig.dir, sessionPath: ref.sessionPath });
		const joined = opened(reply, 1);

		expect(joined.sessionId).toBe(ref.sessionId);
		expect(joined.attached).toBe(true);
		expect(joined.state).toMatchObject({ sessionId: ref.durableSessionId, sessionFile: ref.sessionPath });
		expect(await rig.list()).toEqual([
			expect.objectContaining({ sessionId: ref.sessionId, status: "open", attachments: 2 }),
		]);
		expect(lifecycleRecords(rig.recordsFor("caller").slice(beforeFirst))).toEqual([]);
		expect(lifecycleRecords(rig.recordsFor("elsewhere"))).toEqual([
			expect.objectContaining({ type: "response", command: "open_session", success: true }),
		]);
		const observed = rig.recordsFor("observer").slice(beforeObserver);
		expect(observed).toContainEqual(
			expect.objectContaining({
				type: "session_status",
				lastChange: expect.objectContaining({ cause: "attach" }),
			}),
		);
		expect(observed.filter((record) => record.type === "session_opened")).toEqual([]);
	});

	it("keeps both holds: the first client leaving does not end the session for the second", async () => {
		await using rig = await attachmentRig();
		const ref = await rig.session();
		opened(await rig.open("elsewhere", { cwd: rig.dir, sessionPath: ref.sessionPath }), 1);
		const beforeSecond = rig.recordsFor("elsewhere").length;

		await rig.drop("caller");

		expect(await rig.list()).toEqual([
			expect.objectContaining({ sessionId: ref.sessionId, status: "open", attachments: 1 }),
		]);
		expect(lifecycleRecords(rig.recordsFor("elsewhere").slice(beforeSecond))).toEqual([]);
		expect(await rig.close("elsewhere", ref.sessionId)).toMatchObject({ success: true });
		expect(await rig.list()).toEqual([]);
	});

	it("opening the same file twice from one client stacks a second hold on the same handle", async () => {
		await using rig = await attachmentRig();
		const ref = await rig.session();

		const again = opened(await rig.open("caller", { cwd: rig.dir, sessionPath: ref.sessionPath }), 1);

		expect(again.sessionId).toBe(ref.sessionId);
		expect(again.attached).toBe(true);
		expect(await rig.list()).toEqual([
			expect.objectContaining({ sessionId: ref.sessionId, status: "open", attachments: 2 }),
		]);
	});
});
