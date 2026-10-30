import { fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { callsRig } from "./4272-calls-support.ts";

// Part of #4272, R3.C3.3: an announcement and a start join one call by id, and reused ids close in creation order.

it("C3.3 an out-of-order announcement joins a started call by id without changing its phase or key", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		const owner = rig.start();
		const bridge = rig.record({
			type: "tool_execution_start",
			toolCallId: "b1",
			toolName: "bash",
			args: { command: "x" },
		});
		const call = fauxToolCall("bash", { command: "x" }, { id: "b1" });
		rig.toolStart(owner, 0, call, "bash");
		rig.toolEnd(owner, 0, call, "bash");
		rig.record({ type: "tool_execution_end", toolCallId: "b1", toolName: "bash", result: "r", isError: false });
		rig.end(owner, [call]);
		const view = await rig.calls();
		expect(view.calls).toHaveLength(1);
		expect(view.calls[0]).toMatchObject({
			runtimeItemKey: `${view.root.sessionEpoch}:${bridge?.sequence}.0`,
			phase: "completed-awaiting-entry",
			owningMessageId: owner.messageId,
			contentIndex: 0,
			input: { announced: { command: "x" }, started: { command: "x" } },
		});
		rig.lane.release(view.root);
	} finally {
		await rig.close();
	}
});

it("C3 cond. 3 a call joined after a bridged start streams its raw prefix through the active block until its end", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		const owner = rig.start();
		rig.record({ type: "tool_execution_start", toolCallId: "b1", toolName: "bash", args: { command: "x" } });
		const call = fauxToolCall("bash", { command: "x" }, { id: "b1" });
		const raw = JSON.stringify({ command: "x" });
		rig.toolStart(owner, 0, call, "bash");
		rig.toolDelta(owner, 0, 0, raw.slice(0, 5));
		const streaming = await rig.calls();
		rig.toolDelta(owner, 0, 5, raw.slice(5));
		rig.toolEnd(owner, 0, call, "bash");
		const announced = await rig.calls();
		expect(streaming.calls).toHaveLength(1);
		expect(streaming.calls[0]).toMatchObject({
			phase: "executing",
			owningMessageId: owner.messageId,
			contentIndex: 0,
			raw: raw.slice(0, 5),
		});
		expect(announced.calls[0]).toMatchObject({ phase: "executing", raw });
		rig.lane.release(streaming.root);
		rig.lane.release(announced.root);
	} finally {
		await rig.close();
	}
});

it("senpi#4278 two overlapping calls with one reused id each end in creation order and no end is late", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		const start = { type: "tool_execution_start", toolCallId: "n1", toolName: "read", args: {} };
		const first = rig.record(start);
		const second = rig.record(start);
		const end = { type: "tool_execution_end", toolCallId: "n1", toolName: "read", isError: false };
		expect(rig.record({ ...end, result: "a" })).toBeDefined();
		const between = await rig.calls();
		expect(rig.record({ ...end, result: "b" })).toBeDefined();
		const ended = await rig.calls();
		expect(rig.record({ ...end, result: "c" }), "a third end has no call left to close").toBeUndefined();
		const again = await rig.calls();
		const epoch = ended.root.sessionEpoch;
		const shape = (entry: { runtimeItemKey: string; phase: string; result: unknown }) => [
			entry.runtimeItemKey,
			entry.phase,
			entry.result,
		];
		expect(between.calls.map(shape)).toEqual([
			[`${epoch}:${first?.sequence}.0`, "completed-awaiting-entry", "a"],
			[`${epoch}:${second?.sequence}.0`, "executing", null],
		]);
		expect(ended.calls.map(shape)).toEqual([
			[`${epoch}:${first?.sequence}.0`, "completed-awaiting-entry", "a"],
			[`${epoch}:${second?.sequence}.0`, "completed-awaiting-entry", "b"],
		]);
		expect(ended.counters).toMatchObject({ reused: 1, ignored: { unknown: 0, late: 0 } });
		expect(again.root.sequence).toBe(ended.root.sequence);
		expect(again.counters.ignored).toEqual({ unknown: 0, late: 1 });
		for (const cut of [between, ended, again]) rig.lane.release(cut.root);
	} finally {
		await rig.close();
	}
});
