import { afterEach, expect, it } from "vitest";
import {
	bundleSinks,
	type TerminalExtensionState,
} from "../../../src/core/extensions/builtin/terminal/extension-state.ts";
import type { MonitorSnapshotEntry } from "../../../src/core/extensions/builtin/terminal/monitor-types.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { LifecycleChildren } from "../../../src/core/lifecycle-children.ts";
import { normalizeWaitItems, waitItemSignature, wakeSourceItems } from "../../../src/core/lifecycle-wait-items.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#4228 review: every reader and producer of named waits agrees on one rule.
const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});
const startedAtMs = Date.parse("2026-10-24T00:00:00.000Z");

it("keeps a child's own named waits through the same reader as the lifecycle record", () => {
	const manager = SessionManager.inMemory();
	const store = {
		get entries() {
			return manager.getEntries();
		},
		append: (report: unknown) => {
			manager.appendCustomEntry("child-lifecycle", report);
		},
		changed: () => {},
	};
	const waitingOn = {
		children: 2,
		childSources: [
			{ source: "senpi-task", activeCount: 2, items: [{ id: "review", label: "Review" }], omittedItems: 1 },
		],
		childReports: [{ taskId: "t-2", childSessionId: "grandchild", runEpoch: 0, state: "running" as const }],
		childReportsOmitted: 3,
		background: [
			{
				source: "jobs",
				activeCount: 5,
				items: [{ id: "job", label: "Compile", startedAt: new Date(startedAtMs).toISOString() }],
				omittedItems: 2,
			},
		],
		human: [],
	};
	const children = new LifecycleChildren(store);
	children.report({
		taskId: "t-1",
		childSessionId: "child",
		runEpoch: 0,
		generation: 1,
		state: "waiting_children",
		waitingOn,
	});
	expect(children.reports[0]?.waitingOn).toEqual(waitingOn);
	expect(new LifecycleChildren(store).reports[0]?.waitingOn).toEqual(waitingOn);
});

it("names terminal monitors by their stable monitorId so runtime id churn does not republish", () => {
	const payloads: unknown[] = [];
	const pi = {
		events: { emit: (name: string, data: unknown) => name === "wake_source_state" && payloads.push(data) },
	} as unknown as ExtensionAPI;
	const state = { parked: true, manifestWriter: null } as unknown as TerminalExtensionState;
	const monitor = (id: string): MonitorSnapshotEntry => ({
		id,
		monitorId: "mon_build",
		description: "Build finished",
		paused: false,
		startedAtMs,
	});
	const sinks = bundleSinks(pi, state);
	sinks.onMonitorState([monitor("runtime-1")]);
	sinks.onMonitorState([monitor("runtime-2")]);
	const [before, after] = payloads.map((payload) =>
		normalizeWaitItems((payload as { readonly monitors?: unknown }).monitors),
	);
	expect(before?.items?.map((item) => item.id)).toEqual(["mon_build"]);
	expect(waitItemSignature(after ?? {})).toBe(waitItemSignature(before ?? {}));
});

it("reads monitors when items is present but undefined, with one rule for the tracker and the binding", async () => {
	const monitors = [{ id: "watch", description: "Build finished", startedAtMs }];
	expect(wakeSourceItems({ items: undefined, monitors })).toBe(monitors);
	const h = await createHarness();
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "rpc" });
	h.getExtensionRunner().emitBusEvent("wake_source_state", {
		source: "terminal-monitors",
		activeCount: 1,
		items: undefined,
		monitors,
	});
	expect(h.session.lifecycle.waitingOn?.background).toEqual([
		{
			source: "terminal-monitors",
			activeCount: 1,
			items: [{ id: "watch", label: "Build finished", startedAt: new Date(startedAtMs).toISOString() }],
		},
	]);
});
