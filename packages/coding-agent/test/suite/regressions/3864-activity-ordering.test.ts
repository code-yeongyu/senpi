import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { LifecycleLedger } from "../../../src/core/lifecycle-ledger.ts";
import { type LifecycleRecord, readLifecycleRecord } from "../../../src/core/lifecycle-record.ts";
import { SessionLifecycleController } from "../../../src/core/session-lifecycle.ts";
import type {
	LifecycleActivity,
	SessionLifecycle,
	SessionLifecycleEvent,
} from "../../../src/core/session-lifecycle-types.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import type { Harness } from "../harness.ts";
import { createBoundLifecycleHarness, runToAgentIdle } from "../lifecycle-test-harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});

it.each([1, 2])("delivers all four boundaries but persists only two records on person turn %i", async (turn) => {
	const h = await createBoundLifecycleHarness({ persistSession: true });
	harnesses.push(h);
	h.setResponses(Array.from({ length: turn }, () => fauxAssistantMessage("Reply.")));
	for (let index = 1; index < turn; index++) await runToAgentIdle(h, () => h.session.prompt("Earlier"));
	const offset = h.events.length;
	const saved = h.sessionManager.getEntries().length;
	await runToAgentIdle(h, () => h.session.prompt("Request"));
	const snapshots = h.events
		.slice(offset)
		.filter((event) => event.type === "session_lifecycle")
		.map((event) => event.lifecycle);
	expect(snapshots.map((snapshot) => [snapshot.state, snapshot.activity?.kind])).toEqual([
		["running", undefined],
		["running", "model"],
		["running", undefined],
		["done", undefined],
	]);
	const seq = snapshots[0].seq;
	expect(snapshots.map((snapshot) => snapshot.seq)).toEqual([seq, seq, seq, seq + 1]);
	expect(snapshots.map((snapshot) => snapshot.activityRevision?.revision)).toEqual([0, 1, 2, 0]);
	expect(new Set(snapshots.map((snapshot) => snapshot.activityRevision?.instanceId)).size).toBe(1);
	const records = h.sessionManager
		.getEntries()
		.slice(saved)
		.filter((entry) => entry.type === "custom" && entry.customType === "session-lifecycle");
	expect(records).toHaveLength(2);
	for (const record of records) {
		expect(record).toHaveProperty("data");
		if (record.type !== "custom") throw new Error("Expected custom lifecycle record");
		expect(record.data).not.toHaveProperty("activity");
		expect(record.data).not.toHaveProperty("activityRevision");
	}
});

const activity: LifecycleActivity = {
	kind: "tool",
	toolName: "test",
	toolCallId: "a",
	since: "2026-10-25T00:00:00.000Z",
	outstanding: 1,
};
const waits = { children: 0, background: [], human: [] };
function fixture(entries: readonly SessionEntry[] = []) {
	const records: LifecycleRecord[] = [];
	const events: SessionLifecycleEvent[] = [];
	const order: string[] = [];
	let fail = false;
	const ledger = new LifecycleLedger({
		sessionId: "ordering",
		entries,
		append: (record) => {
			order.push("append");
			if (fail) throw new Error("refused");
			records.push(record);
		},
		emit: (event) => {
			order.push("emit");
			events.push(event);
		},
	});
	ledger.releaseRestoreBarrier();
	const update = (input: Partial<Parameters<LifecycleLedger["update"]>[0]> = {}) =>
		ledger.update({ state: "running", waits, holds: [], ...input });
	if (!entries.length) {
		ledger.startRun("human");
		update();
		ledger.publishUnwritten();
	}
	return {
		ledger,
		update,
		records,
		events,
		order,
		refuse: () => {
			fail = true;
		},
	};
}
function entry(record: unknown): SessionEntry {
	return {
		type: "custom",
		id: "saved",
		parentId: null,
		timestamp: activity.since,
		customType: "session-lifecycle",
		data: record,
	};
}

it("compares every activity field separately and versions absence without durable traffic", () => {
	const f = fixture();
	const before = f.ledger.snapshot;
	const writes = f.records.length;
	const projections: (LifecycleActivity | undefined)[] = [
		activity,
		{ ...activity, outstanding: 2 },
		{ ...activity, toolCallId: "b" },
		{ ...activity, toolName: "other" },
		{ ...activity, since: "2026-10-25T00:00:01.000Z" },
		{ kind: "model", since: activity.since },
		undefined,
	];
	for (const [index, projection] of projections.entries()) {
		f.update({ activity: projection });
		expect(f.ledger.snapshot.seq).toBe(before.seq);
		expect(f.ledger.snapshot.activityRevision).toEqual({
			instanceId: before.activityRevision?.instanceId,
			revision: index + 1,
		});
		const count = f.events.length;
		f.update({ activity: projection });
		expect(f.events).toHaveLength(count);
	}
	expect(f.records).toHaveLength(writes);
	expect(f.events).toHaveLength(1 + projections.length);
	expect(before.activity).toBeUndefined();
	expect(before.activityRevision?.revision).toBe(0);
	expect(f.ledger.snapshot.persisted).toBe(before.persisted);
	expect(f.ledger.snapshot.selfSettleEligible).toBe(before.selfSettleEligible);
});

it.each(["hold", "attention", "input", "terminal", "run", "checkpoint"] as const)(
	"preserves independently required %s writes beside an activity boundary",
	(boundary) => {
		const f = fixture();
		const before = f.ledger.snapshot;
		const writes = f.records.length;
		f.order.length = 0;
		if (boundary === "input") f.ledger.humanInput(activity.since);
		if (boundary === "run") f.ledger.startRun("automatic");
		if (boundary === "checkpoint") f.ledger.checkpoint();
		f.update({
			activity,
			...(boundary === "hold" ? { state: "held", holds: [{ kind: "session_hold", since: activity.since }] } : {}),
			...(boundary === "attention"
				? {
						state: "waiting_human",
						waits: {
							...waits,
							human: [
								{
									kind: "question",
									originSessionId: "ordering",
									requestId: "q",
									revision: 1,
									since: activity.since,
								},
							],
						},
					}
				: {}),
			...(boundary === "terminal" ? { state: "done" } : {}),
		});
		f.ledger.publishUnwritten();
		expect(f.records).toHaveLength(writes + 1);
		expect(f.ledger.snapshot.seq).toBe(before.seq + 1);
		expect(f.order.indexOf("append")).toBeLessThan(f.order.indexOf("emit"));
		expect(f.events.at(-1)?.lifecycle.activity).toEqual(activity);
		expect(f.records.at(-1)).not.toHaveProperty("activityRevision");
		if (!["input", "checkpoint"].includes(boundary)) {
			expect(f.ledger.snapshot.activityRevision?.revision).toBe(0);
			expect(f.order).toEqual(["append", "emit"]);
		}
	},
);

it("restores with a fresh owner before the barrier and ignores both durable activity fields", () => {
	const f = fixture();
	f.update({ activity });
	f.ledger.checkpoint();
	const old = f.ledger.snapshot;
	const tainted = { ...f.records.at(-1), activity, activityRevision: old.activityRevision };
	expect(readLifecycleRecord(tainted)).not.toHaveProperty("activity");
	expect(readLifecycleRecord(tainted)).not.toHaveProperty("activityRevision");
	const records: LifecycleRecord[] = [];
	const restored = new LifecycleLedger({
		sessionId: "ordering",
		entries: [entry(tainted)],
		append: (r) => records.push(r),
		emit: () => {},
	});
	expect(restored.snapshot).toMatchObject({ seq: old.seq, restoring: true, activityRevision: { revision: 0 } });
	expect(restored.snapshot.activityRevision?.instanceId).not.toBe(old.activityRevision?.instanceId);
	expect(restored.snapshot.activity).toBeUndefined();
	expect(records).toEqual([]);
});

it("fences the numeric key reused after a failed checkpoint and keeps failed-write retries truthful", () => {
	const f = fixture();
	f.update({ activity });
	const saved = f.records.at(-1);
	f.refuse();
	f.ledger.checkpoint();
	const failed = f.ledger.snapshot;
	expect(failed).toMatchObject({ persisted: false, selfSettleEligible: false });
	expect(failed.activityRevision?.revision).toBe(0);
	const restored = fixture([entry(saved)]);
	restored.update();
	// restoreComplete checkpoints a nonzero restored sequence after recomputation.
	restored.ledger.checkpoint();
	expect(restored.ledger.snapshot.seq).toBe(failed.seq);
	expect(restored.ledger.snapshot.activityRevision?.revision).toBe(0);
	expect(restored.ledger.snapshot.activityRevision?.instanceId).not.toBe(failed.activityRevision?.instanceId);
	expect(restored.ledger.snapshot.activity).toBeUndefined();
	const writes = f.order.filter((item) => item === "append").length;
	f.update({ activity: { ...activity, outstanding: 2 } });
	expect(f.order.filter((item) => item === "append")).toHaveLength(writes + 1);
	expect(f.ledger.snapshot.persisted).toBe(false);
	expect(f.records).toHaveLength(1);
});

it.each(["message_end", "tool_execution_end", "agent_end", "idle", "hold"] as const)(
	"clears live activity with a versioned snapshot at %s",
	(boundary) => {
		const events: SessionLifecycle[] = [];
		const runtime = {
			activity: {
				isStreaming: false,
				isCompacting: false,
				isBashRunning: false,
				hasSessionWork: false,
				hasActiveWakeSource: false,
			},
			pendingMessages: 0,
			holds: [] as { kind: "session_hold"; since: string }[],
			human: [],
		};
		const controller = new SessionLifecycleController({
			sessionId: "clear",
			entries: [],
			append: () => {},
			appendChild: () => {},
			appendCustody: () => {},
			emit: (event) => events.push(event.lifecycle),
			readRuntime: () => runtime,
		});
		controller.restoreComplete();
		controller.startRun();
		const message = fauxAssistantMessage("Streaming");
		if (boundary === "message_end") controller.observeActivity({ type: "message_start", message, streaming: true });
		else controller.observeActivity({ type: "tool_execution_start", toolCallId: "a", toolName: "test", args: {} });
		const before = controller.snapshot;
		if (boundary === "idle") controller.idle();
		else if (boundary === "hold") {
			runtime.holds.push({ kind: "session_hold", since: activity.since });
			controller.recompute();
		} else if (boundary === "message_end") controller.observeActivity({ type: "message_end", message });
		else if (boundary === "agent_end") controller.observeActivity({ type: "agent_end", messages: [] });
		else
			controller.observeActivity({
				type: "tool_execution_end",
				toolCallId: "a",
				toolName: "test",
				result: {},
				isError: false,
			});
		expect(controller.snapshot.activity).toBeUndefined();
		expect(controller.snapshot.activityRevision).toEqual({
			instanceId: before.activityRevision?.instanceId,
			revision: controller.snapshot.seq === before.seq ? (before.activityRevision?.revision ?? 0) + 1 : 0,
		});
		expect(events.at(-1)).toBe(controller.snapshot);
	},
);
