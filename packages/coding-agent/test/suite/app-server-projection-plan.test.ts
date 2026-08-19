import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import { EventProjector } from "../../src/modes/app-server/threads/projection.ts";
import { TurnLog } from "../../src/modes/app-server/threads/turn-log.ts";

const usage: Usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		responseId: "msg-1",
		usage,
		stopReason: "stop",
		timestamp: 1,
	};
}

function collect(events: readonly AgentSessionEvent[]) {
	const turnLog = new TurnLog();
	turnLog.recordTurn("thread-1", { turnId: "turn-1", startedAt: "2026-07-02T00:00:00.000Z" });
	const projector = new EventProjector({
		threadId: "thread-1",
		turnId: "turn-1",
		turnLog,
		cwd: "/tmp/project",
		nowMs: () => 1234,
	});
	return events.flatMap((event) => projector.project(event).notifications);
}

function toolEvents(toolName: string, result: unknown): AgentSessionEvent[] {
	const message = assistant([{ type: "toolCall", id: "tool-1", name: toolName, arguments: {} }]);
	return [
		{
			type: "message_update",
			message,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: { type: "toolCall", id: "tool-1", name: toolName, arguments: {} },
				partial: message,
			},
		},
		{ type: "tool_execution_end", toolCallId: "tool-1", toolName, result, isError: false },
	];
}

type PlanParams = {
	readonly threadId?: string;
	readonly turnId?: string;
	readonly explanation?: string | null;
	readonly plan?: readonly unknown[];
};

function planNotifications(outputs: readonly { method: string; params: unknown }[]): PlanParams[] {
	return outputs
		.filter((output) => output.method === "turn/plan/updated")
		.map((output) => output.params as PlanParams);
}

describe("app-server turn/plan/updated projection", () => {
	it("emits turn/plan/updated with V2 statuses when the todo tool completes with phases", () => {
		// Given: a todo tool execution whose structured details carry every senpi status.
		const result = {
			content: [{ type: "text", text: "summary" }],
			details: {
				op: "init",
				storage: "memory",
				phases: [
					{
						name: "Setup",
						tasks: [
							{ content: "pending task", status: "pending" },
							{ content: "active task", status: "in_progress" },
							{ content: "done task", status: "completed" },
							{ content: "dropped task", status: "abandoned" },
						],
					},
				],
			},
		};

		// When: the events are projected.
		const outputs = collect(toolEvents("todo", result));

		// Then: exactly one plan notification carries the flattened steps, and every
		// status is a V2 status (abandoned collapses to completed).
		const plan = planNotifications(outputs);
		expect(plan).toHaveLength(1);
		expect(plan[0]).toEqual({
			threadId: "thread-1",
			turnId: "turn-1",
			explanation: null,
			plan: [
				{ step: "pending task", status: "pending" },
				{ step: "active task", status: "inProgress" },
				{ step: "done task", status: "completed" },
				{ step: "dropped task", status: "completed" },
			],
		});
		// And: the original tool item still completes normally alongside the plan.
		expect(outputs.some((output) => output.method === "item/completed")).toBe(true);
	});

	it("emits an empty plan when the todo tool clears all phases", () => {
		// Given: a todo rm result whose details carry an empty phases array.
		const result = {
			content: [{ type: "text", text: "cleared" }],
			details: { op: "rm", storage: "memory", phases: [] },
		};

		// When: the events are projected.
		const outputs = collect(toolEvents("todo", result));

		// Then: the cleared plan state is emitted as an empty step list.
		const plan = planNotifications(outputs);
		expect(plan).toHaveLength(1);
		expect(plan[0]?.plan).toEqual([]);
	});

	it("emits no turn/plan/updated for a turn without the todo tool", () => {
		// Given: a bash tool execution with no plan state.
		const result = { content: [{ type: "text", text: "ok" }], details: { exitCode: 0 } };

		// When: the events are projected.
		const outputs = collect(toolEvents("bash", result));

		// Then: no plan notification is invented.
		expect(planNotifications(outputs)).toEqual([]);
	});

	it("emits no turn/plan/updated when the todo result lacks structured phases", () => {
		// Given: a todo tool error result with no details payload.
		const result = { content: [{ type: "text", text: "Missing op" }] };

		// When: the events are projected.
		const outputs = collect(toolEvents("todo", result));

		// Then: missing details produce no notification and no invented steps.
		expect(planNotifications(outputs)).toEqual([]);
	});

	it("skips malformed phases and unknown statuses without crashing", () => {
		// Given: todo details mixing valid tasks with malformed phases and an unknown status.
		const result = {
			content: [{ type: "text", text: "summary" }],
			details: {
				phases: [
					"not-a-phase",
					{ name: "Broken" },
					{
						name: "Setup",
						tasks: [
							{ content: "real task", status: "pending" },
							{ content: "mystery task", status: "mystery" },
							{ status: "pending" },
						],
					},
				],
			},
		};

		// When: the events are projected.
		const outputs = collect(toolEvents("todo", result));

		// Then: only the well-formed task is projected; nothing is invented.
		const plan = planNotifications(outputs);
		expect(plan).toHaveLength(1);
		expect(plan[0]?.plan).toEqual([{ step: "real task", status: "pending" }]);
	});
});
