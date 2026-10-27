import { afterEach, expect, it } from "vitest";
import type { LifecycleApi } from "../../../src/core/session-lifecycle-types.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#3864: task identity and lifecycle generations fence every child report.
const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});

it("ignores a stale child generation without replacing live custody", async () => {
	// Given the current child generation is still running.
	let api: LifecycleApi | undefined;
	const h = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("session_start", () => {
					api = pi.lifecycle;
				});
			},
		],
	});
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "rpc" });
	if (!api) throw new Error("pi.lifecycle must be bound before session_start");
	api.reportChild({
		taskId: "review",
		childSessionId: "child-review",
		runEpoch: 2,
		generation: 7,
		state: "running",
		label: "Review changes",
		since: "2026-10-21T00:00:00.000Z",
	});

	// When an older generation claims completion.
	api.reportChild({
		taskId: "review",
		childSessionId: "child-review",
		runEpoch: 2,
		generation: 6,
		state: "done",
		terminal: "completed",
	});

	// Then the parent still owns live child work.
	expect(h.session.lifecycle).toMatchObject({
		state: "waiting_children",
		waitingOn: {
			children: 1,
			childReports: [
				{
					taskId: "review",
					childSessionId: "child-review",
					runEpoch: 2,
					state: "running",
					label: "Review changes",
					since: "2026-10-21T00:00:00.000Z",
				},
			],
		},
	});
	const reports = h.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "child-lifecycle");
	expect(reports).toHaveLength(1);
});

it("clears a terminal child when a higher run epoch reports revival", async () => {
	// Given a failed child run.
	const h = await createHarness();
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "rpc" });
	expect(h.session.reportChildLifecycle).toBeTypeOf("function");
	h.session.reportChildLifecycle({
		taskId: "review",
		childSessionId: "child-review",
		runEpoch: 2,
		generation: 70,
		state: "failed",
		terminal: "error",
	});
	const terminalSeq = h.session.lifecycle.seq;
	// Same-epoch terminal finality also rejects a newer generation.
	h.session.reportChildLifecycle({
		taskId: "review",
		childSessionId: "child-review",
		runEpoch: 2,
		generation: 71,
		state: "running",
	});
	expect(h.session.lifecycle.seq).toBe(terminalSeq);
	expect(h.session.lifecycle.waitingOn?.children).toBe(0);

	// When the runner revives it with a new epoch, even with a lower generation.
	h.session.reportChildLifecycle({
		taskId: "review",
		childSessionId: "child-review",
		runEpoch: 3,
		generation: 1,
		state: "running",
		label: "Revived review",
		since: "2026-10-22T00:00:00.000Z",
	});

	// Then old terminal state cannot release the new run's obligation.
	expect(h.session.lifecycle).toMatchObject({
		state: "waiting_children",
		waitingOn: {
			children: 1,
			childReports: [
				{
					taskId: "review",
					childSessionId: "child-review",
					runEpoch: 3,
					state: "running",
					label: "Revived review",
					since: "2026-10-22T00:00:00.000Z",
				},
			],
		},
	});
});

it("sorts and caps eligible child reports without counting own or terminal reports as omitted", async () => {
	const h = await createHarness();
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "rpc" });
	for (let i = 32; i >= 0; i--)
		h.session.reportChildLifecycle({
			taskId: `task-${String(i).padStart(2, "0")}`,
			childSessionId: `child-${i}`,
			runEpoch: 1,
			generation: 1,
			state: "running",
		});
	h.session.reportChildLifecycle({
		taskId: "aaa-own",
		childSessionId: h.session.sessionId,
		runEpoch: 1,
		generation: 1,
		state: "running",
	});
	h.session.reportChildLifecycle({
		taskId: "aaa-terminal",
		childSessionId: "finished",
		runEpoch: 1,
		generation: 1,
		state: "done",
		terminal: "completed",
	});
	const waits = h.session.lifecycle.waitingOn;
	expect(waits?.children).toBe(33);
	expect(waits?.childReportsOmitted).toBe(1);
	expect(waits?.childReports?.map((report) => report.taskId)).toEqual(
		Array.from({ length: 32 }, (_, i) => `task-${String(i).padStart(2, "0")}`),
	);
});

it("restores named and legacy child reports while dropping malformed optional detail", async () => {
	const manager = SessionManager.inMemory();
	const named = {
		taskId: "named",
		childSessionId: "child-named",
		runEpoch: 4,
		generation: 9,
		state: "running",
		label: "Persisted review",
		since: "2026-10-21T03:00:00.000Z",
	} as const;
	const h = await createHarness({ sessionManager: manager });
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "rpc" });
	h.session.reportChildLifecycle(named);
	const persisted = manager
		.getEntries()
		.find((entry) => entry.type === "custom" && entry.customType === "child-lifecycle");
	expect(persisted).toMatchObject({ data: named });
	manager.appendCustomEntry("child-lifecycle", {
		sessionId: h.session.sessionId,
		taskId: "legacy",
		childSessionId: "child-legacy",
		runEpoch: 0,
		generation: 1,
		state: "running",
	});
	manager.appendCustomEntry("child-lifecycle", {
		sessionId: h.session.sessionId,
		taskId: "malformed",
		childSessionId: "child-malformed",
		runEpoch: 1,
		generation: 1,
		state: "running",
		label: 42,
		since: "not-a-date",
	});
	const restored = await createHarness({ sessionManager: manager });
	harnesses.push(restored);
	await restored.session.bindExtensions({ mode: "rpc" });
	expect(restored.session.lifecycle.waitingOn).toMatchObject({
		children: 3,
		childReports: [
			{ taskId: "legacy", childSessionId: "child-legacy", runEpoch: 0, state: "running" },
			{ taskId: "malformed", childSessionId: "child-malformed", runEpoch: 1, state: "running" },
			{
				taskId: "named",
				childSessionId: "child-named",
				runEpoch: 4,
				state: "running",
				label: named.label,
				since: named.since,
			},
		],
	});
	const malformed = restored.session.lifecycle.waitingOn?.childReports?.find(
		(report) => report.taskId === "malformed",
	);
	expect(malformed).not.toHaveProperty("label");
	expect(malformed).not.toHaveProperty("since");
});

it("drops child human waits while the runner owns automatic answers", async () => {
	// Given an automatically answered child's dialog in its registration window.
	const h = await createHarness();
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "rpc" });
	expect(h.session.reportChildLifecycle).toBeTypeOf("function");

	// When the runner relays that child's snapshot.
	h.session.reportChildLifecycle({
		taskId: "review",
		childSessionId: "child-review",
		runEpoch: 1,
		generation: 1,
		state: "waiting_human",
		waitingOn: {
			children: 0,
			background: [],
			human: [
				{
					kind: "approval",
					originSessionId: "child-review",
					requestId: "dialog-1",
					revision: 1,
					since: "2026-10-21T00:00:00.000Z",
				},
			],
		},
	});

	// Then the root waits on the child, not a human who cannot answer it.
	expect(h.session.lifecycle).toMatchObject({
		state: "waiting_children",
		waitingOn: { children: 1, human: [] },
	});
});

it("keeps a fork as a root rather than deriving child role from file ancestry", async () => {
	// Given an ordinary fork with historical parentSession metadata.
	const h = await createHarness({
		sessionManager: SessionManager.inMemory(undefined, { parentSession: "/synthetic/parent.jsonl" }),
	});
	harnesses.push(h);

	// When its extensions finish restoring.
	await h.session.bindExtensions({ mode: "rpc" });

	// Then only spawnedBy, never ancestry, establishes child identity.
	expect(h.session.lifecycle).toMatchObject({ role: "root", rootSessionId: h.session.sessionId });
});
