import { stripVTControlCharacters } from "node:util";
import { type Container, TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import type { SessionLifecycle } from "../../../src/core/session-lifecycle-types.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { subscribeSessionRecords } from "../../../src/modes/rpc/session-record-stream.ts";
import { createHarness, type Harness } from "../harness.ts";
import { createLifecycleHarness } from "../lifecycle-test-harness.ts";
import { createTuiLifecycle, emit, invoke, render } from "../tui-lifecycle-harness.ts";

const cleanups: Array<() => unknown> = [];
beforeAll(() => initTheme("dark"));
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

const terminal = (h?: Harness) => createTuiLifecycle(cleanups, h);

it("renders initial lifecycle status and live named child/background waits from the real bus, matching RPC content", async () => {
	const { h, publish } = await createLifecycleHarness();
	const { mode } = await terminal(h);
	expect(render(mode)).toContain(h.session.lifecycle.state);
	const records: object[] = [];
	cleanups.push(subscribeSessionRecords(h.session, (record) => records.push(record)));
	publish("wake_source_state", {
		source: "senpi-task",
		kind: "children",
		activeCount: 2,
		items: [{ id: "child-a", description: "Compile parser" }],
	});
	publish("wake_source_state", {
		source: "terminal",
		activeCount: 1,
		items: [{ id: "job-a", description: "Watch build" }],
	});
	const lifecycle = h.session.lifecycle;
	expect(lifecycle.state).toBe("waiting_children");
	expect(records).toContainEqual({
		type: "session_lifecycle",
		lifecycle: { ...lifecycle, observedAt: expect.any(String) },
	});
	const output = render(mode);
	expect(output).toContain("waiting_children");
	expect(output).toContain("children: 2");
	for (const source of [...(lifecycle.waitingOn?.childSources ?? []), ...(lifecycle.waitingOn?.background ?? [])])
		for (const item of source.items ?? []) expect(output).toContain(item.label ?? item.id);
	render(mode, 40);
});

it.each([
	{
		state: "waiting_children" as const,
		lastStop: { cause: "deadline" as const, deadline: "max_runtime" as const },
		text: "deadline: max_runtime",
	},
	{
		state: "waiting_human" as const,
		lastStop: { cause: "goal_guard" as const, guard: "cap" },
		text: "goal_guard: cap",
	},
	{
		state: "waiting_human" as const,
		lastStop: { cause: "todo_guard" as const, todo: "cap" as const },
		text: "todo_guard: cap",
	},
])("renders $text independently of the coarse state", async ({ state, lastStop, text }) => {
	const { harness, mode, base } = await terminal();
	emit(harness.session, {
		...base,
		state,
		lastStop: { ...lastStop, runId: "stopped-run", at: base.since, epoch: base.epoch },
		waitingOn: {
			children: 1,
			background: [],
			human: [
				{
					kind: "goal_blocked",
					originSessionId: harness.session.sessionId,
					requestId: "goal",
					revision: 1,
					since: base.since,
				},
			],
		},
	});
	expect(render(mode)).toContain(state);
	expect(render(mode)).toContain(text);
	expect(render(mode)).toContain("goal_blocked");
});

it("renders a lost child failure and named child reports without inventing model activity", async () => {
	const { harness, mode, base } = await terminal();
	emit(harness.session, { ...base, state: "failed", failure: { reason: "lost", taskId: "lost-task", runEpoch: 2 } });
	expect(render(mode)).toContain("failed");
	expect(render(mode)).toContain("lost");
	expect(render(mode)).toContain("lost-task");
	emit(harness.session, {
		...base,
		seq: 101,
		state: "waiting_children",
		waitingOn: {
			children: 1,
			background: [],
			human: [],
			childReports: [
				{
					taskId: "reported",
					childSessionId: "child",
					runEpoch: 2,
					state: "waiting_human",
					label: "Review schema",
				},
			],
		},
	});
	expect(render(mode)).toContain("Review schema");
	expect(render(mode)).not.toContain("activity: model");
});

it("renders same-seq outstanding counts 1,2,1 and rejects replays, older seq, foreign owners and legacy tombstones", async () => {
	const { harness, mode, base } = await terminal();
	const tool = { kind: "tool" as const, toolName: "bash", toolCallId: "A", since: base.since, outstanding: 1 };
	const update = (revision: number, outstanding: number): SessionLifecycle => ({
		...base,
		activity: { ...tool, outstanding },
		activityRevision: { instanceId: base.activityRevision?.instanceId ?? "", revision },
	});
	for (const [revision, count] of [
		[1, 1],
		[2, 2],
		[3, 1],
	]) {
		emit(harness.session, update(revision, count));
		expect(render(mode)).toContain(`outstanding: ${count}`);
	}
	const current = render(mode);
	const renderEffect = vi.spyOn(
		mode as unknown as { setExtensionStatus(key: string, text: string | undefined): void },
		"setExtensionStatus",
	);
	for (const stale of [
		update(3, 99),
		update(2, 99),
		{ ...update(900, 99), seq: 99 },
		{ ...update(900, 99), activityRevision: { instanceId: "unbound", revision: 900 } },
		{ ...base, activityRevision: undefined },
	]) {
		emit(harness.session, stale);
		expect(render(mode)).toBe(current);
	}
	expect(renderEffect).not.toHaveBeenCalled();
	// Equal-seq content must not replace ordinary state or replay its render effects.
	emit(harness.session, { ...update(4, 2), state: "failed", failure: { reason: "lost" } });
	expect(render(mode)).toContain("running");
	expect(render(mode)).not.toContain("lost");
	emit(harness.session, { ...base, seq: 101, state: "done", completionId: "once" });
	const completed = render(mode);
	emit(harness.session, { ...base, seq: 101, state: "failed" });
	expect(render(mode)).toBe(completed);
	expect(renderEffect).toHaveBeenCalledTimes(2);
});

it("synchronizes a new activity owner only from the current authoritative snapshot at equal seq", async () => {
	const { harness, mode, base } = await terminal();
	const model = { kind: "model" as const, since: base.since };
	emit(harness.session, {
		...base,
		activity: model,
		activityRevision: { instanceId: base.activityRevision?.instanceId ?? "", revision: 5 },
	});
	const replacement = { ...base, activityRevision: { instanceId: "new-owner", revision: 0 } };
	vi.spyOn(harness.session, "lifecycle", "get").mockReturnValue(replacement);
	invoke(mode, "subscribeToAgent");
	expect(render(mode)).not.toContain("activity: model");
	emit(harness.session, {
		...replacement,
		activity: model,
		activityRevision: { instanceId: "new-owner", revision: 1 },
	});
	const current = render(mode);
	emit(harness.session, {
		...base,
		activityRevision: { instanceId: base.activityRevision?.instanceId ?? "", revision: 900 },
	});
	expect(render(mode)).toBe(current);
	// A newer legacy state keeps its ordinary semantics; equal legacy state is not an activity tombstone.
	emit(harness.session, { ...base, seq: 101, state: "waiting_background", activityRevision: undefined });
	expect(render(mode)).toContain("waiting_background");
	expect(render(mode)).not.toContain("activity: model");
});

it("retains same-owner high water, fences replacement at equal seq and detaches on disposal", async () => {
	const { harness, runtime, mode, base } = await terminal();
	const getter = vi.spyOn(harness.session, "lifecycle", "get");
	const model = { kind: "model" as const, since: base.since };
	emit(harness.session, {
		...base,
		activity: model,
		activityRevision: { instanceId: base.activityRevision?.instanceId ?? "", revision: 5 },
	});
	getter.mockReturnValue({
		...base,
		activityRevision: { instanceId: base.activityRevision?.instanceId ?? "", revision: 1 },
	});
	invoke(mode, "subscribeToAgent");
	expect(render(mode)).toContain("activity: model");
	const replacement = await createHarness({ siblingOf: harness });
	cleanups.push(() => replacement.cleanup());
	const oldCallbacks: Array<(event: AgentSessionEvent) => unknown> = [];
	const subscribe = harness.session.subscribe.bind(harness.session);
	vi.spyOn(harness.session, "subscribe").mockImplementation((callback) => {
		oldCallbacks.push(callback);
		return subscribe(callback);
	});
	invoke(mode, "subscribeToAgent");
	const replacementBase = { ...base, activityRevision: { instanceId: "replacement", revision: 0 } };
	vi.spyOn(replacement.session, "lifecycle", "get").mockReturnValue(replacementBase);
	Reflect.set(runtime, "_session", replacement.session);
	invoke(mode, "subscribeToAgent");
	expect(render(mode)).not.toContain("activity: model");
	emit(replacement.session, {
		...replacementBase,
		activity: model,
		activityRevision: { instanceId: "replacement", revision: 1 },
	});
	expect(render(mode)).toContain("activity: model");
	const late = {
		type: "session_lifecycle" as const,
		sessionId: harness.session.sessionId,
		lifecycle: { ...base, seq: 900, activity: undefined },
	};
	emit(harness.session, late.lifecycle);
	for (const callback of oldCallbacks) await callback(late);
	expect(render(mode)).toContain("activity: model");
	emit(replacement.session, {
		...replacementBase,
		seq: 101,
		state: "failed",
		failure: { reason: "lost" },
		activityRevision: { instanceId: "unknown", revision: 1 },
	});
	expect(render(mode)).toContain("failed");
	expect(render(mode)).not.toContain("activity: model");
	Reflect.set(mode, "isInitialized", false);
	mode.stop({ restoreStderr: false });
	const disposed = render(mode);
	emit(replacement.session, { ...replacementBase, seq: 102, state: "running", activity: model });
	for (const callback of oldCallbacks) await callback(late);
	expect(render(mode)).toBe(disposed);
});

it("keeps rendered compaction and retry detail when versioned activity clears", async () => {
	const { harness, mode, base } = await terminal();
	const status = Reflect.get(mode, "statusContainer") as Container;
	const ui = new TUI(new VirtualTerminal(80, 24));
	cleanups.push(() => ui.stop());
	for (const kind of ["compaction", "retry"]) {
		const detail = { kind, render: () => [`${kind} progress`], invalidate: () => {}, dispose: vi.fn() };
		Reflect.set(mode, "activeStatusIndicator", detail);
		status.clear();
		status.addChild(detail);
		emit(harness.session, { ...base, seq: kind === "retry" ? 101 : 100, activity: undefined });
		expect(stripVTControlCharacters(status.render(80).join("\n"))).toContain(`${kind} progress`);
		expect(detail.dispose).not.toHaveBeenCalled();
		expect(render(mode)).toContain("running");
		expect(render(mode)).not.toContain("activity: model");
	}
});
