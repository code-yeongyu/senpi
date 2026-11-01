import { fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { callsRig } from "./4272-calls-support.ts";

// Part of #4272, R3.C3.1-C3.3 (RULING-13): the outstanding-call phase machine on the S04 lane.

const args = { path: "a.txt", text: "hello" };
const RAW = JSON.stringify(args);

it("T3a C3.2 C3.3 phases only move forward and every cut holds the exact raw prefix", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		const owner = rig.start();
		const call = fauxToolCall("write", args, { id: "call-a" });
		const started = rig.toolStart(owner, 0, call, "write");
		rig.toolDelta(owner, 0, 0, RAW.slice(0, 7));
		const streaming = await rig.calls();
		rig.toolDelta(owner, 0, 7, RAW.slice(7));
		rig.toolEnd(owner, 0, call, "write");
		rig.end(owner, [call]);
		const announced = await rig.calls();
		rig.record({ type: "tool_execution_start", toolCallId: "call-a", toolName: "write", args });
		rig.record({ type: "tool_execution_update", toolCallId: "call-a", toolName: "write", args, partialResult: 1 });
		const executing = await rig.calls();
		rig.record({ type: "tool_execution_end", toolCallId: "call-a", toolName: "write", result: "ok", isError: false });
		const completed = await rig.calls();

		const key = `${streaming.root.sessionEpoch}:${started?.sequence}.0`;
		expect(streaming.calls).toHaveLength(1);
		expect(streaming.calls[0]).toMatchObject({
			runtimeItemKey: key,
			turnId: started?.turnId,
			toolCallId: "call-a",
			owningMessageId: owner.messageId,
			contentIndex: 0,
			phase: "streaming",
			requestedName: "write",
			resolvedName: "write",
			raw: RAW.slice(0, 7),
			input: { announced: null, started: null, prepared: null },
		});
		expect(streaming.root.activeMessageId).toBe(owner.messageId);
		expect(announced.root.activeMessageId).toBeNull();
		expect(announced.calls[0]).toMatchObject({
			runtimeItemKey: key,
			phase: "awaiting-execution",
			raw: RAW,
			input: { announced: args, started: null, prepared: null },
		});
		expect(executing.calls[0]).toMatchObject({
			runtimeItemKey: key,
			phase: "executing",
			raw: RAW,
			input: { announced: args, started: args, prepared: args },
			progress: 1,
			startSequence: executing.root.sequence - 1,
		});
		expect(completed.calls[0]).toMatchObject({
			runtimeItemKey: key,
			phase: "completed-awaiting-entry",
			result: "ok",
			outcome: { kind: "result", isError: false, source: "execution_end" },
		});
		expect((await rig.calls(streaming.root)).calls[0], "a held cut never moves").toMatchObject({
			phase: "streaming",
			raw: RAW.slice(0, 7),
		});
		for (const cut of [streaming, announced, executing, completed]) rig.lane.release(cut.root);
	} finally {
		await rig.close();
	}
});

it("C3.1 Q1 a provider id that changes after toolcall_start re-indexes the call and keeps its key", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		const owner = rig.start();
		const call = fauxToolCall("read", { path: "x" }, { id: "late-id" });
		const started = rig.toolStart(owner, 0, { ...call, id: "" }, "read");
		rig.blockName(owner, 0, "read_file");
		rig.toolEnd(owner, 0, call, "read");
		rig.end(owner, [call]);
		rig.record({ type: "tool_execution_start", toolCallId: "late-id", toolName: "read", args: { path: "x" } });
		const view = await rig.calls();
		expect(view.calls).toHaveLength(1);
		expect(view.calls[0]).toMatchObject({
			runtimeItemKey: `${view.root.sessionEpoch}:${started?.sequence}.0`,
			toolCallId: "late-id",
			requestedName: "read",
			phase: "executing",
		});
		expect(view.counters).toMatchObject({ collisions: 0, reused: 0 });
		rig.lane.release(view.root);
	} finally {
		await rig.close();
	}
});

it("C3.1 activeMessage:null never clears outstanding calls", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		const owner = rig.start();
		const call = fauxToolCall("bash", { command: "ls" }, { id: "c1" });
		rig.toolStart(owner, 0, call, "bash");
		rig.toolEnd(owner, 0, call, "bash");
		rig.end(owner, [call]);
		const view = await rig.calls();
		expect(view.root.activeMessageId).toBeNull();
		expect(view.calls.map((entry) => [entry.toolCallId, entry.phase])).toEqual([["c1", "awaiting-execution"]]);
		rig.lane.release(view.root);
	} finally {
		await rig.close();
	}
});

it("C3.1 a later assistant message never clears earlier calls", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		const first = rig.start();
		const call = fauxToolCall("bash", { command: "ls" }, { id: "c1" });
		rig.toolStart(first, 0, call, "bash");
		rig.toolEnd(first, 0, call, "bash");
		rig.end(first, [call]);
		rig.record({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
		rig.record({ type: "turn_end", message: {}, toolResults: [] });
		rig.record({ type: "turn_start" });
		const second = rig.start();
		rig.end(second, [{ type: "text", text: "plain" }]);
		const view = await rig.calls();
		expect(view.calls.map((entry) => [entry.toolCallId, entry.phase])).toEqual([["c1", "executing"]]);
		expect(view.calls[0]?.owningMessageId).toBe(first.messageId);
		rig.lane.release(view.root);
	} finally {
		await rig.close();
	}
});

it("Q9 ignored execution records take no sequence and publish no calls root", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		const before = await rig.calls();
		for (const record of [
			{ type: "tool_execution_update", toolCallId: "ghost", toolName: "t", args: {}, partialResult: 1 },
			{ type: "tool_execution_end", toolCallId: "ghost", toolName: "t", result: "x", isError: false },
			{ type: "tool_hook_status", toolCallId: "codemode-1", hookName: "PreToolUse", phase: "start" },
		])
			expect(rig.lane.accept(record, undefined), `${record.type} is ignored`).toBeUndefined();
		const after = await rig.calls();
		expect(after.root.sequence).toBe(before.root.sequence);
		expect(after.sequence).toBe(before.sequence);
		expect(after.calls).toEqual([]);
		expect(after.counters.ignored).toEqual({ unknown: 3, late: 0 });
		rig.lane.release(before.root);
		rig.lane.release(after.root);
	} finally {
		await rig.close();
	}
});

it("Q9 a folded execution record takes the lane sequence the cut and the calls root publish", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		const started = rig.record({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: {} });
		const executing = await rig.calls();
		expect(started?.sequence).toBe(executing.root.sequence);
		expect(executing.sequence, "the calls root moved at the record's own sequence").toBe(executing.root.sequence);
		expect(executing.calls[0]).toMatchObject({
			runtimeItemKey: `${executing.root.sessionEpoch}:${started?.sequence}.0`,
			startSequence: started?.sequence,
		});
		const ghost = { type: "tool_execution_end", toolCallId: "ghost", toolName: "bash", result: "x", isError: false };
		expect(rig.record(ghost)).toBeUndefined();
		const ended = rig.record({ ...ghost, toolCallId: "c1" });
		const completed = await rig.calls();
		expect(ended?.sequence, "the ignored end left no gap").toBe((started?.sequence ?? 0) + 1);
		expect(completed.root.sequence).toBe(ended?.sequence);
		expect(completed.sequence).toBe(ended?.sequence);
		expect(completed.counters.ignored).toEqual({ unknown: 1, late: 0 });
		rig.lane.release(executing.root);
		rig.lane.release(completed.root);
	} finally {
		await rig.close();
	}
});

it("Q9 an ignored execution end outside a turn mints no turn and leaves the lane untouched", async () => {
	const rig = await callsRig();
	try {
		const before = rig.lane.freeze();
		const ghost = { type: "tool_execution_end", toolCallId: "ghost", toolName: "t", result: "x", isError: false };
		expect(rig.lane.accept(ghost, undefined)).toBeUndefined();
		const after = await rig.calls();
		expect(after.root.turnId).toBeNull();
		expect(after.root.sequence).toBe(before.sequence);
		expect(after.root.correlation).toBe(before.correlation);
		expect(after.root.activeMessageId).toBeNull();
		expect(after.calls).toEqual([]);
		expect(after.counters.ignored).toEqual({ unknown: 1, late: 0 });
		const next = rig.record({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: {} });
		expect(next?.sequence).toBe(before.sequence + 1);
		rig.lane.release(before);
		rig.lane.release(after.root);
	} finally {
		await rig.close();
	}
});

it("Q9 an ignored execution end carrying a new client identity commits no correlation and takes no sequence", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start", clientMessageId: "m1", clientTurnId: "A" });
		rig.record({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: {} });
		const before = rig.lane.freeze();
		const end = { type: "tool_execution_end", toolName: "bash", result: "x", isError: false };
		const identified = { ...end, clientMessageId: "m2", clientTurnId: "B" };
		expect(rig.record({ ...identified, toolCallId: "ghost" })).toBeUndefined();
		const after = rig.lane.freeze();
		expect(before.correlation).toMatchObject({ clientMessageId: "m1", clientTurnId: "A" });
		expect(after.sequence).toBe(before.sequence);
		expect(after.correlation, "the ignored end committed no correlation").toBe(before.correlation);
		const ended = rig.record({ ...identified, toolCallId: "c1" });
		const committed = rig.lane.freeze();
		expect(ended?.sequence, "the correlation change takes one sequence just before the real end").toBe(
			before.sequence + 2,
		);
		expect(committed.correlation).toMatchObject({
			sequence: before.sequence + 1,
			clientMessageId: "m2",
			clientTurnId: "B",
		});
		for (const root of [before, after, committed]) rig.lane.release(root);
	} finally {
		await rig.close();
	}
});

it("C3.3 a duplicate execution end is late, changes nothing and takes no sequence", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		rig.record({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: {} });
		const end = { type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: "a", isError: false };
		rig.record(end);
		const ended = await rig.calls();
		expect(rig.record({ ...end, result: "b" })).toBeUndefined();
		const again = await rig.calls();
		expect(again.root.sequence).toBe(ended.root.sequence);
		expect(again.calls[0]?.result).toBe("a");
		expect(again.counters.ignored).toEqual({ unknown: 0, late: 1 });
		rig.lane.release(ended.root);
		rig.lane.release(again.root);
	} finally {
		await rig.close();
	}
});
