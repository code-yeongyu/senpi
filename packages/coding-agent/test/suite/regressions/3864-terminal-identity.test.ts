import { expect, it } from "vitest";
import { LifecycleChildren } from "../../../src/core/lifecycle-children.ts";
import { LifecycleLedger } from "../../../src/core/lifecycle-ledger.ts";
import type { ChildLifecycleReport, SessionLifecycle, SpawnedBy } from "../../../src/core/session-lifecycle-types.ts";

// senpi#3864 review (#3963): a child's terminal is final within its run epoch, and a terminal id is per session.
const report = (patch: Partial<ChildLifecycleReport>): ChildLifecycleReport => ({
	taskId: "task-1",
	childSessionId: "child-1",
	runEpoch: 1,
	generation: 1,
	state: "running",
	...patch,
});

it("keeps a child terminal against a later report in the same run epoch", () => {
	// Given a child that completed in run epoch 1.
	const children = new LifecycleChildren({ entries: [], append: () => {}, changed: () => {} });
	children.report(report({ generation: 5, state: "done", terminal: "completed" }));

	// When a higher generation in the same epoch reports it running again.
	children.report(report({ generation: 6, state: "running" }));

	// Then the child stays terminal, and the parent waits on no children.
	expect(children.reports).toEqual([expect.objectContaining({ generation: 5, terminal: "completed" })]);
	expect(children.activeCount).toBe(0);
});

it("gives a child's terminal a completion id of its own, never its root's", () => {
	// Given a root and its child, both finishing their first epoch.
	const terminalOf = (sessionId: string, spawnedBy?: SpawnedBy): SessionLifecycle => {
		let latest: SessionLifecycle | undefined;
		const ledger = new LifecycleLedger({
			sessionId,
			...(spawnedBy ? { spawnedBy } : {}),
			entries: [],
			append: () => {},
			emit: (event) => {
				latest = event.lifecycle;
			},
		});
		ledger.releaseRestoreBarrier();
		ledger.startRun("human");
		ledger.update({ state: "done", waits: { children: 0, background: [], human: [] }, holds: [] });
		return latest ?? ledger.snapshot;
	};

	// When both publish their terminal.
	const root = terminalOf("root-1");
	const child = terminalOf("child-1", { parentSessionId: "root-1", rootSessionId: "root-1", taskId: "task-1" });

	// Then each id names its own session, so a client deduping by completionId keeps both.
	expect(root.completionId).toBe("root-1:1");
	expect(child.completionId).toBe("child-1:1");
});
