import { expect, it } from "vitest";
import { LifecycleLedger } from "../../../src/core/lifecycle-ledger.ts";
import type { LifecycleRecord } from "../../../src/core/lifecycle-record.ts";
import type { LifecycleActivity, SessionLifecycleEvent } from "../../../src/core/session-lifecycle-types.ts";

// senpi#4231 review: a failed custody write marks the lifecycle unpersisted, but activity alone still only emits.
const activity: LifecycleActivity = {
	kind: "tool",
	toolName: "test",
	toolCallId: "a",
	since: "2026-10-25T00:00:00.000Z",
	outstanding: 1,
};
const waits = { children: 0, background: [], human: [] };

it("emits activity changes without durable appends while custody writes fail", () => {
	const records: LifecycleRecord[] = [];
	const events: SessionLifecycleEvent[] = [];
	const ledger = new LifecycleLedger({
		sessionId: "custody",
		entries: [],
		append: (record) => records.push(record),
		emit: (event) => events.push(event),
	});
	ledger.releaseRestoreBarrier();
	const update = (projection?: LifecycleActivity) =>
		ledger.update({ state: "running", waits, holds: [], activity: projection });
	ledger.startRun("human");
	update();
	ledger.publishUnwritten();
	const before = ledger.snapshot;
	const writes = records.length;

	ledger.custodyWriteFailed();
	update(activity);
	update({ ...activity, outstanding: 2 });
	update();

	expect(records).toHaveLength(writes);
	expect(events.slice(-3).map((event) => event.lifecycle.activity)).toEqual([
		activity,
		{ ...activity, outstanding: 2 },
		undefined,
	]);
	expect(ledger.snapshot).toMatchObject({
		seq: before.seq,
		persisted: false,
		selfSettleEligible: false,
		activityRevision: { instanceId: before.activityRevision?.instanceId, revision: 3 },
	});
});
