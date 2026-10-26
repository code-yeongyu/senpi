import { afterEach, expect, it } from "vitest";
import { readLifecycleRecord } from "../../../src/core/lifecycle-record.ts";
import { SessionLifecycleController } from "../../../src/core/session-lifecycle.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";
import { createIdentityHarness } from "../rpc-client-identity-harness.ts";

// senpi#3864: aggregate custody remains authoritative while optional source snapshots name the work.
const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});
const startedAtMs = Date.parse("2026-10-24T00:00:00.000Z");

it("carries senpi-task items through custody to the real RPC wire", async () => {
	const fixture = await createIdentityHarness();
	try {
		await fixture.session.bindExtensions({ mode: "rpc" });
		fixture.harness.getExtensionRunner().emitBusEvent("wake_source_state", {
			source: "senpi-task",
			kind: "children",
			activeCount: 3,
			items: [{ id: "review", description: "Review patch", startedAtMs }],
		});
		const state = await fixture.bind().send({ type: "get_state" });
		expect(state).toMatchObject({
			data: {
				lifecycle: {
					waitingOn: {
						children: 3,
						childSources: [
							{
								source: "senpi-task",
								activeCount: 3,
								items: [
									{ id: "review", label: "Review patch", startedAt: new Date(startedAtMs).toISOString() },
								],
							},
						],
					},
				},
			},
		});
	} finally {
		await fixture.cleanup();
	}
});

it("publishes same-count replacement but ignores reorder, progress, and timestamp churn", async () => {
	const h = await createHarness();
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "rpc" });
	const emit = (items: unknown[]) =>
		h.getExtensionRunner().emitBusEvent("wake_source_state", {
			source: "senpi-task",
			kind: "children",
			activeCount: 2,
			items,
		});
	emit([{ id: "a", description: "A", startedAtMs }, { id: "b" }]);
	const seq = h.session.lifecycle.seq;
	emit([
		{ id: "b", progress: 90 },
		{ id: "a", description: "A", startedAtMs: startedAtMs + 100 },
	]);
	expect(h.session.lifecycle.seq).toBe(seq);
	emit([{ id: "c" }, { id: "a", description: "A" }]);
	expect(h.session.lifecycle.seq).toBeGreaterThan(seq);
	const replacement = h.session.lifecycle.seq;
	emit([
		{ id: "c", description: "Changed label" },
		{ id: "a", description: "A" },
	]);
	expect(h.session.lifecycle.seq).toBeGreaterThan(replacement);
});

it("sorts, deduplicates, and caps snapshots without deriving omissions from activeCount", async () => {
	const h = await createHarness();
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "rpc" });
	const items = Array.from({ length: 33 }, (_, i) => ({ id: `job-${String(i).padStart(2, "0")}` })).reverse();
	h.getExtensionRunner().emitBusEvent("wake_source_state", {
		source: "terminal-background-sessions",
		activeCount: 90,
		items: [...items, items[0], { id: "" }, { id: 3 }, { description: "Unnamed" }],
	});
	expect(h.session.lifecycle.waitingOn?.background).toEqual([
		{
			source: "terminal-background-sessions",
			activeCount: 90,
			items: [...items].reverse().slice(0, 32),
			omittedItems: 1,
		},
	]);
});

it("normalizes monitor detail and terminal jobs while invalid detail keeps the count", async () => {
	const h = await createHarness();
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "rpc" });
	const events = h.getExtensionRunner();
	events.emitBusEvent("wake_source_state", {
		source: "terminal-monitors",
		activeCount: 1,
		monitors: [{ id: "watch", description: "Build finished", startedAtMs }],
	});
	events.emitBusEvent("wake_source_state", {
		source: "terminal-background-sessions",
		activeCount: 2,
		items: [{ id: "job", description: 42, startedAtMs: Infinity }, { description: "No id" }],
	});
	expect(h.session.lifecycle.waitingOn?.background).toEqual([
		{
			source: "terminal-monitors",
			activeCount: 1,
			items: [{ id: "watch", label: "Build finished", startedAt: new Date(startedAtMs).toISOString() }],
		},
		{ source: "terminal-background-sessions", activeCount: 2, items: [{ id: "job" }] },
	]);
	events.emitBusEvent("wake_source_state", {
		source: "terminal-background-sessions",
		activeCount: 2,
		items: [{ id: null }],
	});
	expect(h.session.lifecycle.waitingOn?.background[1]).toEqual({
		source: "terminal-background-sessions",
		activeCount: 2,
	});
});

it("restores named custody through the registry and recompute and still retires unpublished sources", () => {
	const manager = SessionManager.inMemory();
	const options = {
		sessionId: manager.getSessionId(),
		append: (record: unknown) => {
			manager.appendCustomEntry("session-lifecycle", record);
		},
		appendChild: (record: unknown) => {
			manager.appendCustomEntry("child-lifecycle", record);
		},
		appendCustody: (record: unknown) => {
			manager.appendCustomEntry("work-custody", record);
		},
		emit: () => {},
		readRuntime: () => ({
			activity: {
				isStreaming: false,
				isBashRunning: false,
				isCompacting: false,
				hasSessionWork: false,
				hasActiveWakeSource: false,
			},
			pendingMessages: 0,
			holds: [],
			human: [],
		}),
	};
	manager.appendCustomEntry("work-custody", {
		id: "named",
		key: "wake-source:jobs",
		source: "jobs",
		kind: "background",
		activeCount: 40,
		state: "open",
		items: [{ id: "job", description: "Compile", startedAtMs }],
		omittedItems: 1,
	});
	manager.appendCustomEntry("work-custody", {
		id: "legacy",
		key: "wake-source:legacy",
		source: "legacy",
		kind: "children",
		activeCount: 2,
		state: "open",
		items: "bad",
	});
	const controller = new SessionLifecycleController({ ...options, entries: manager.getEntries() });
	controller.restoreComplete();
	controller.obligations.syncSource("senpi-task", "children", 3, [
		{ id: "review", description: "Review patch", startedAtMs },
	]);
	expect(controller.snapshot.waitingOn).toMatchObject({
		children: 5,
		background: [
			{
				source: "jobs",
				activeCount: 40,
				items: [{ id: "job", label: "Compile", startedAt: new Date(startedAtMs).toISOString() }],
				omittedItems: 1,
			},
		],
	});
	const record = manager
		.getEntries()
		.findLast((entry) => entry.type === "custom" && entry.customType === "session-lifecycle");
	expect(record?.type).toBe("custom");
	if (record?.type !== "custom") throw new Error("Missing lifecycle record");
	expect(readLifecycleRecord(record.data)?.waitingOn).toEqual(controller.snapshot.waitingOn);
	const restored = new SessionLifecycleController({ ...options, entries: manager.getEntries() });
	restored.restoreComplete();
	expect(restored.snapshot.waitingOn).toEqual(controller.snapshot.waitingOn);
	restored.obligations.retireRestoredSources();
	expect(restored.obligations.activeCount).toBe(0);
});
