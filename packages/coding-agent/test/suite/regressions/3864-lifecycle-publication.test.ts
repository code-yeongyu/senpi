import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import goalExtension from "../../../src/core/extensions/builtin/goal/index.ts";
import type { TurnEndLivenessInput } from "../../../src/core/extensions/builtin/goal/turn-end-liveness.ts";
import type { LifecycleRecord } from "../../../src/core/lifecycle-record.ts";
import { SessionLifecycleController } from "../../../src/core/session-lifecycle.ts";
import type { SessionLifecycleEvent } from "../../../src/core/session-lifecycle-types.ts";
import type { Harness } from "../harness.ts";
import { createBoundLifecycleHarness as createHarness, runToAgentIdle } from "../lifecycle-test-harness.ts";

// senpi#3864: completion is a durable root-work seal, not a turn-end guess.
const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
	vi.restoreAllMocks();
});

it("publishes a persisted goal completion only after agent_idle", async () => {
	// Given a real goal extension and a goal completed through its tool.
	const h = await createHarness({ persistSession: true, extensionFactories: [goalExtension] });
	harnesses.push(h);
	h.setResponses([
		fauxAssistantMessage([fauxToolCall("update_goal", { status: "complete" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("The work is complete."),
	]);

	// When the root finishes the goal.
	await runToAgentIdle(h, () => h.session.prompt("/goal Complete the requested change"));

	// Then one persisted seal follows idle, never settlement alone.
	expect(h.session.lifecycle).toMatchObject({
		state: "done",
		restoring: false,
		persisted: true,
		role: "root",
		completion: { kind: "goal" },
	});
	const completions = h.events.filter(
		(event) => event.type === "session_lifecycle" && event.lifecycle.state === "done",
	);
	expect(completions).toHaveLength(1);
	const completedAt = h.events.findIndex(
		(event) => event.type === "session_lifecycle" && event.lifecycle.state === "done",
	);
	expect(h.events.findIndex((event) => event.type === "agent_idle")).toBeLessThan(completedAt);
	const persistedAt = h.events.findLastIndex(
		(event) =>
			event.type === "entry_appended" &&
			event.entry.type === "custom" &&
			event.entry.customType === "session-lifecycle",
	);
	expect(persistedAt).toBeLessThan(completedAt);
	expect(h.session.lifecycle.completionId).toBe(`${h.session.sessionId}:${h.session.lifecycle.epoch}`);
});

it("opens the next epoch when an automatic wake follows a sealed reply", async () => {
	// Given a sealed root reply.
	const h = await createHarness();
	harnesses.push(h);
	h.setResponses([fauxAssistantMessage("First reply."), fauxAssistantMessage("Wake reply.")]);
	await runToAgentIdle(h, () => h.session.prompt("First request"));
	expect(h.session.lifecycle).toMatchObject({ state: "done" });
	const sealedEpoch = h.session.lifecycle.epoch;

	// When an automatic delivery starts another turn.
	await runToAgentIdle(h, () =>
		h.session.sendCustomMessage(
			{ customType: "senpi-monitor:notification", content: "Changed", display: false },
			{ triggerTurn: true },
		),
	);

	// Then its distinct epoch is automatic, although its message entered the model.
	expect(h.session.lifecycle).toMatchObject({
		state: "done",
		epoch: sealedEpoch + 1,
		epochOrigin: "automatic",
		completionId: `${h.session.sessionId}:${sealedEpoch + 1}`,
	});
});

it("keeps child custody through an atomic handoff to a queued wake", async () => {
	// Given an idle root holding a child obligation.
	const h = await createHarness();
	harnesses.push(h);
	expect(h.session.workObligations).toBeDefined();
	const child = h.session.workObligations.open("task:review", "children");

	// When the producer transfers custody synchronously.
	const queued = child.transfer("omo-wake-queue:review");

	// Then no transient terminal state or zero-custody window is observable.
	expect(h.session.workObligations.activeCount).toBe(1);
	expect(h.session.lifecycle).toMatchObject({ state: "waiting_children", waitingOn: { children: 1 } });
	expect(
		h.events.filter((event) => event.type === "session_lifecycle" && event.lifecycle.state === "done"),
	).toHaveLength(0);
	queued.close("cancelled");
});

it("rejects transfer after a producer has already released custody", async () => {
	// Given an obligation that was closed before the handoff.
	const h = await createHarness();
	harnesses.push(h);
	expect(h.session.workObligations).toBeDefined();
	const child = h.session.workObligations.open("task:review", "children");
	child.close("cancelled");

	// When the producer attempts the invalid handoff.
	const transfer = () => child.transfer("omo-wake-queue:review");

	// Then the producer bug is rejected instead of silently losing work.
	expect(transfer).toThrow();
});

function activityFixture(
	entries: ConstructorParameters<typeof SessionLifecycleController>[0]["entries"] = [],
	startRun = true,
) {
	const records: LifecycleRecord[] = [];
	const events: SessionLifecycleEvent[] = [];
	const runtime = {
		activity: {
			isStreaming: false,
			isCompacting: false,
			isBashRunning: false,
			hasSessionWork: false,
			hasActiveWakeSource: false,
		},
		pendingMessages: 0,
		holds: [],
		human: [],
	};
	const controller = new SessionLifecycleController({
		sessionId: "activity",
		entries,
		append: (record) => records.push(record),
		appendChild: () => {},
		appendCustody: () => {},
		emit: (event) => events.push(event),
		readRuntime: () => runtime,
	});
	controller.restoreComplete();
	if (startRun) controller.startRun();
	return { controller, records, events, runtime };
}

const toolStart = (toolCallId: string, parentToolCallId?: string) => ({
	type: "tool_execution_start" as const,
	toolCallId,
	toolName: `tool-${toolCallId}`,
	args: {},
	...(parentToolCallId ? { parentToolCallId } : {}),
});
const toolEnd = (toolCallId: string, parentToolCallId?: string) => ({
	type: "tool_execution_end" as const,
	toolCallId,
	toolName: `tool-${toolCallId}`,
	result: { content: [], details: {} },
	isError: false,
	...(parentToolCallId ? { parentToolCallId } : {}),
});

it("selects the oldest outstanding top-level tool and never invents model activity at tool end", () => {
	const { controller, records } = activityFixture();
	const start = Date.parse("2026-10-25T00:00:00.000Z");
	const clock = vi.spyOn(Date, "now").mockReturnValue(start);
	controller.observeActivity(toolStart("a"));
	const since = controller.snapshot.activity?.since;
	expect(since).toBe(new Date(start).toISOString());
	expect(controller.snapshot.activity).toMatchObject({ kind: "tool", toolCallId: "a", outstanding: 1 });
	const count = records.length;
	controller.observeActivity(toolStart("nested", "a"));
	controller.observeActivity(toolEnd("nested", "a"));
	expect(records).toHaveLength(count);
	clock.mockReturnValue(start + 1000);
	controller.observeActivity(toolStart("b"));
	expect(controller.snapshot.activity).toMatchObject({ toolCallId: "a", outstanding: 2, since });
	clock.mockReturnValue(start + 2000);
	controller.observeActivity(toolEnd("a"));
	expect(controller.snapshot.activity).toMatchObject({
		kind: "tool",
		toolCallId: "b",
		outstanding: 1,
		since: new Date(start + 1000).toISOString(),
	});
	controller.observeActivity(toolEnd("b"));
	expect(controller.snapshot.activity).toBeUndefined();
});

it("publishes outstanding counts 1, 2, 1 at one lifecycle seq under distinct activity keys", () => {
	const { controller, records, events } = activityFixture();
	const offset = records.length;
	controller.observeActivity(toolStart("a"));
	const first = controller.snapshot;
	controller.observeActivity(toolStart("b"));
	controller.observeActivity(toolEnd("b"));
	expect(events.slice(-3).map((event) => event.lifecycle.activity)).toEqual(
		[1, 2, 1].map((outstanding) => ({
			kind: "tool",
			toolName: "tool-a",
			toolCallId: "a",
			since: first.activity?.since,
			outstanding,
		})),
	);
	expect(records.slice(offset)).toEqual([]);
	expect(events.slice(-3).map((event) => event.lifecycle.seq)).toEqual(Array(3).fill(first.seq));
	expect(events.slice(-3).map((event) => event.lifecycle.activityRevision)).toEqual(
		[1, 2, 3].map((revision) => ({ instanceId: first.activityRevision?.instanceId, revision })),
	);
	expect(first.activity?.kind === "tool" && first.activity.outstanding).toBe(1);
});

it("ignores user and tool-result messages and records model since only at assistant streaming start", () => {
	const { controller } = activityFixture();
	expect(controller.snapshot.activity).toBeUndefined();
	controller.observeActivity({ type: "message_start", message: { role: "user", content: "Hi", timestamp: 1 } });
	controller.observeActivity({
		type: "message_start",
		message: { role: "toolResult", toolCallId: "a", toolName: "tool-a", content: [], isError: false, timestamp: 2 },
	});
	expect(controller.snapshot.activity).toBeUndefined();
	const message = fauxAssistantMessage("Streaming");
	controller.observeActivity({ type: "message_start", message: fauxAssistantMessage("Prepared, not streaming") });
	expect(controller.snapshot.activity).toBeUndefined();
	const start = new Date("2026-10-25T00:00:00.000Z");
	const clock = vi.spyOn(Date, "now").mockReturnValue(start.getTime());
	try {
		controller.observeActivity({ type: "message_start", message, streaming: true });
		expect(controller.snapshot.activity).toEqual({ kind: "model", since: start.toISOString() });
		clock.mockReturnValue(start.getTime() + 1000);
		controller.recompute();
		expect(controller.snapshot.activity?.since).toBe(start.toISOString());
		controller.observeActivity({ type: "message_end", message });
		expect(controller.snapshot.activity).toBeUndefined();
	} finally {
		clock.mockRestore();
	}
});

it("ignores 100 token deltas and tool progress without writing", () => {
	const { controller, records, events } = activityFixture();
	const message = fauxAssistantMessage("Streaming");
	controller.observeActivity({ type: "message_start", message, streaming: true });
	const count = records.length;
	const model = controller.snapshot;
	const modelEvents = events.length;
	for (let i = 0; i < 100; i++)
		controller.observeActivity({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: message },
		});
	expect(records).toHaveLength(count);
	expect(events).toHaveLength(modelEvents);
	expect(controller.snapshot).toBe(model);
	controller.observeActivity({ type: "message_end", message });
	controller.observeActivity(toolStart("a"));
	const tools = records.length;
	const tool = controller.snapshot;
	const toolEvents = events.length;
	for (let i = 0; i < 100; i++)
		controller.observeActivity({
			type: "tool_execution_update",
			toolCallId: "a",
			toolName: "tool-a",
			args: {},
			partialResult: {},
		});
	expect(records).toHaveLength(tools);
	expect(events).toHaveLength(toolEvents);
	expect(controller.snapshot).toBe(tool);
});

it("clears activity at run end and reset while compaction and queued work remain unlabelled", () => {
	const { controller, runtime } = activityFixture();
	controller.observeActivity(toolStart("a"));
	controller.observeActivity({ type: "agent_end", messages: [] });
	runtime.activity.isCompacting = true;
	controller.recompute();
	expect(controller.snapshot).toMatchObject({ state: "running" });
	expect(controller.snapshot.activity).toBeUndefined();
	controller.startRun();
	expect(controller.snapshot.activity).toBeUndefined();
	controller.observeActivity(toolStart("b"));
	controller.startRun();
	expect(controller.snapshot.activity).toBeUndefined();
	controller.observeActivity(toolStart("c"));
	controller.idle();
	expect(controller.snapshot.activity).toBeUndefined();
	runtime.activity.isCompacting = false;
	runtime.pendingMessages = 1;
	controller.recompute();
	expect(controller.snapshot).toMatchObject({ state: "running" });
	expect(controller.snapshot.activity).toBeUndefined();
});

it("keeps activity wire-only while the durable record keeps the published sequence", () => {
	const { controller, records } = activityFixture();
	controller.observeActivity(toolStart("a"));
	expect(controller.snapshot.activity).toMatchObject({ toolCallId: "a" });
	expect(records.at(-1)).not.toHaveProperty("activity");
	expect(records.at(-1)?.seq).toBe(controller.snapshot.seq);
});

it("omits model activity during a provider retry interval after the failed run ends", () => {
	const { controller, runtime } = activityFixture();
	const message = fauxAssistantMessage("Partial", { stopReason: "error" });
	controller.observeActivity({ type: "message_start", message, streaming: true });
	controller.observeActivity({ type: "agent_end", messages: [message] });
	const retry: TurnEndLivenessInput = {
		isChildSession: false,
		mode: "rpc",
		ledgerHold: undefined,
		endedBy: "provider-error",
		willRetry: true,
		deadlineStop: false,
		goalStopped: false,
		openWork: { kind: "none" },
		continuationQueued: undefined,
		expectations: [],
		budgetSpent: false,
		providerRetryAtMs: undefined,
	};
	runtime.activity.hasSessionWork = true;
	controller.goalFacts(null, retry);
	controller.idle();
	expect(controller.snapshot).toMatchObject({ state: "running" });
	expect(controller.snapshot.activity).toBeUndefined();
});

it("never resurrects activity from a restored record", () => {
	const { controller, records } = activityFixture();
	controller.observeActivity(toolStart("a"));
	const record = { ...records.at(-1), activity: controller.snapshot.activity };
	const restored = activityFixture(
		[
			{
				type: "custom",
				id: "saved",
				parentId: null,
				timestamp: new Date().toISOString(),
				customType: "session-lifecycle",
				data: record,
			},
		],
		false,
	);
	expect(restored.controller.snapshot.activity).toBeUndefined();
});
