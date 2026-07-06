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
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

function assistant(content: AssistantMessage["content"], responseId = "msg-1"): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		responseId,
		usage,
		stopReason: "stop",
		timestamp: 1,
	};
}

function collect(events: readonly AgentSessionEvent[]) {
	const turnLog = new TurnLog();
	turnLog.recordTurn("thread-1", {
		turnId: "turn-1",
		startedAt: "2026-07-02T00:00:00.000Z",
	});
	const projector = new EventProjector({
		threadId: "thread-1",
		turnId: "turn-1",
		turnLog,
		cwd: "/tmp/project",
		nowMs: () => 1234,
	});
	const outputs = events.flatMap((event) => projector.project(event).notifications);
	return { outputs, turns: turnLog.readTurns("thread-1"), projector };
}

const itemScope = { threadId: "thread-1", turnId: "turn-1" } as const;
const reasoningStarted = { type: "reasoning", id: "msg-1:0", summary: [], content: [] };
const reasoningCompleted = { type: "reasoning", id: "msg-1:0", summary: [], content: ["secret-reasoning"] };
const agentStarted = { type: "agentMessage", id: "msg-1:1", text: "", phase: null, memoryCitation: null };
const agentCompleted = { type: "agentMessage", id: "msg-1:1", text: "answer", phase: null, memoryCitation: null };

function started(item: Record<string, unknown>) {
	return { method: "item/started", params: { ...itemScope, startedAtMs: 1234, item } };
}

function completed(item: Record<string, unknown>) {
	return { method: "item/completed", params: { ...itemScope, completedAtMs: 1234, item } };
}

function commandItem(status: "inProgress" | "completed", aggregatedOutput: string | null, exitCode: number | null) {
	return {
		type: "commandExecution",
		id: "tool-1",
		command: "printf ok",
		cwd: "/tmp/project",
		processId: null,
		source: "agent",
		status,
		commandActions: [],
		aggregatedOutput,
		exitCode,
		durationMs: null,
	};
}

describe("app-server AgentEvent projector", () => {
	it("keeps interleaved reasoning separate from agent-message deltas", () => {
		// Given: a streamed assistant message where private thinking and answer text interleave.
		const events: AgentSessionEvent[] = [
			{ type: "message_start", message: assistant([]) },
			{
				type: "message_update",
				message: assistant([{ type: "thinking", thinking: "" }]),
				assistantMessageEvent: {
					type: "thinking_start",
					contentIndex: 0,
					partial: assistant([{ type: "thinking", thinking: "" }]),
				},
			},
			{
				type: "message_update",
				message: assistant([{ type: "thinking", thinking: "secret-reasoning" }]),
				assistantMessageEvent: {
					type: "thinking_delta",
					contentIndex: 0,
					delta: "secret-reasoning",
					partial: assistant([{ type: "thinking", thinking: "secret-reasoning" }]),
				},
			},
			{
				type: "message_update",
				message: assistant([{ type: "text", text: "" }]),
				assistantMessageEvent: {
					type: "text_start",
					contentIndex: 1,
					partial: assistant([{ type: "text", text: "" }]),
				},
			},
			{
				type: "message_update",
				message: assistant([{ type: "text", text: "answer" }]),
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 1,
					delta: "answer",
					partial: assistant([{ type: "text", text: "answer" }]),
				},
			},
			{
				type: "message_update",
				message: assistant([
					{ type: "thinking", thinking: "secret-reasoning" },
					{ type: "text", text: "answer" },
				]),
				assistantMessageEvent: {
					type: "thinking_end",
					contentIndex: 0,
					content: "secret-reasoning",
					partial: assistant([
						{ type: "thinking", thinking: "secret-reasoning" },
						{ type: "text", text: "answer" },
					]),
				},
			},
			{
				type: "message_update",
				message: assistant([
					{ type: "thinking", thinking: "secret-reasoning" },
					{ type: "text", text: "answer" },
				]),
				assistantMessageEvent: {
					type: "text_end",
					contentIndex: 1,
					content: "answer",
					partial: assistant([
						{ type: "thinking", thinking: "secret-reasoning" },
						{ type: "text", text: "answer" },
					]),
				},
			},
		];

		// When: the events are projected to app-server notifications.
		const { outputs, turns } = collect(events);

		// Then: reasoning text only appears on reasoning notifications and completed reasoning items.
		expect(outputs).toEqual([
			started(reasoningStarted),
			{
				method: "item/reasoning/textDelta",
				params: { ...itemScope, itemId: "msg-1:0", delta: "secret-reasoning", contentIndex: 0 },
			},
			started(agentStarted),
			{
				method: "item/agentMessage/delta",
				params: { ...itemScope, itemId: "msg-1:1", delta: "answer" },
			},
			completed(reasoningCompleted),
			completed(agentCompleted),
		]);
		expect(turns[0]?.items).toEqual([reasoningCompleted, agentCompleted]);
	});

	it("projects a bash tool round-trip and stores the completed command item", () => {
		// Given: a completed assistant tool call followed by command execution output.
		const message = assistant([
			{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "printf ok" } },
		]);
		const events: AgentSessionEvent[] = [
			{
				type: "message_update",
				message,
				assistantMessageEvent: {
					type: "toolcall_end",
					contentIndex: 0,
					toolCall: { type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "printf ok" } },
					partial: message,
				},
			},
			{
				type: "tool_execution_update",
				toolCallId: "tool-1",
				toolName: "bash",
				args: { command: "printf ok" },
				partialResult: { content: [{ type: "text", text: "ok" }] },
			},
			{
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "bash",
				result: { content: [{ type: "text", text: "ok" }], details: { exitCode: 0 } },
				isError: false,
			},
		];

		// When: the events are projected.
		const { outputs, turns } = collect(events);

		// Then: command execution starts, streams output, completes, and the turn log gets the same completed item.
		const commandStarted = commandItem("inProgress", null, null);
		const commandCompleted = commandItem("completed", "ok", 0);
		expect(outputs).toEqual([
			started(commandStarted),
			{
				method: "item/commandExecution/outputDelta",
				params: { ...itemScope, itemId: "tool-1", delta: "ok" },
			},
			completed(commandCompleted),
		]);
		expect(turns[0]?.items).toEqual([commandCompleted]);
	});

	it("keeps in-flight tool items open across message boundaries within one turn", () => {
		// Given: a turn where the assistant message finishes (done) before its tool executes,
		// which is the normal shape of every multi-message tool-using turn.
		const message = assistant([
			{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "printf ok" } },
		]);
		const events: AgentSessionEvent[] = [
			{
				type: "message_update",
				message,
				assistantMessageEvent: {
					type: "toolcall_end",
					contentIndex: 0,
					toolCall: { type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "printf ok" } },
					partial: message,
				},
			},
			{
				type: "message_update",
				message,
				assistantMessageEvent: { type: "done", reason: "stop", message },
			},
			{
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "bash",
				result: { content: [{ type: "text", text: "ok" }], details: { exitCode: 0 } },
				isError: false,
			},
		];

		// When: the events are projected.
		const { outputs, turns } = collect(events);

		// Then: `done` does not force-complete the pending tool; the execution result does.
		const commandCompleted = commandItem("completed", "ok", 0);
		expect(outputs).toEqual([started(commandItem("inProgress", null, null)), completed(commandCompleted)]);
		expect(turns[0]?.items).toEqual([commandCompleted]);
	});

	it("finalize closes dangling tool items exactly once", () => {
		// Given: a projected tool call that never executed before turn end.
		const message = assistant([
			{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "printf ok" } },
		]);
		const { projector } = collect([
			{
				type: "message_update",
				message,
				assistantMessageEvent: {
					type: "toolcall_end",
					contentIndex: 0,
					toolCall: { type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "printf ok" } },
					partial: message,
				},
			},
		]);

		// When: the turn is finalized twice and another event arrives afterwards.
		const firstFinalize = projector.finalize();
		const secondFinalize = projector.finalize();
		const afterFinalize = projector.project({
			type: "tool_execution_end",
			toolCallId: "tool-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "late" }], details: { exitCode: 0 } },
			isError: false,
		});

		// Then: the dangling tool completes once and post-finalize events are dropped.
		expect(firstFinalize).toEqual([completed(commandItem("completed", null, null))]);
		expect(secondFinalize).toEqual([]);
		expect(afterFinalize.notifications).toEqual([]);
	});

	it("caps oversized bash output deltas and completed items on a UTF-8 boundary", () => {
		// Given: bash streams output whose next character would cross the 256 KiB projection cap.
		const cappedDelta = "d".repeat(256 * 1024 - 1),
			cappedCompletedOutput = "c".repeat(256 * 1024 - 1);
		const oversizedDelta = `${cappedDelta}한suffix`;
		const oversizedCompletedOutput = `${cappedCompletedOutput}한suffix`;
		const events: AgentSessionEvent[] = [
			{
				type: "tool_execution_start",
				toolCallId: "tool-1",
				toolName: "bash",
				args: { command: "printf ok" },
			},
			{
				type: "tool_execution_update",
				toolCallId: "tool-1",
				toolName: "bash",
				args: { command: "printf ok" },
				partialResult: { content: [{ type: "text", text: oversizedDelta }] },
			},
			{
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "bash",
				result: { content: [{ type: "text", text: oversizedCompletedOutput }], details: { exitCode: 0 } },
				isError: false,
			},
		];

		// When: the events are projected.
		const { outputs, turns } = collect(events);

		// Then: both the stream delta and completed turn item stop before the multibyte character.
		const commandCompleted = commandItem("completed", cappedCompletedOutput, 0);
		expect(new TextEncoder().encode(cappedDelta).byteLength).toBe(256 * 1024 - 1);
		expect(new TextEncoder().encode(cappedCompletedOutput).byteLength).toBe(256 * 1024 - 1);
		expect(outputs).toEqual([
			{
				method: "item/commandExecution/outputDelta",
				params: { ...itemScope, itemId: "tool-1", delta: cappedDelta },
			},
			completed(commandCompleted),
		]);
		expect(turns[0]?.items).toEqual([commandCompleted]);
	});
});
