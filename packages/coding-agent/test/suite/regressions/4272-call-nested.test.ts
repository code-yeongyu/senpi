import { expect, it } from "vitest";
import { announced, callsRig } from "./4272-calls-support.ts";

// Part of #4272, R3.C3.3 (RULING-13 Q5): nested calls: parentKey resolution, reused nested ids, and children riding
// on the parent's projection.

it("Q5 completed nested children ride on the parent projection and an executing one ends carrierless as an orphan", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		await announced(rig, "p1", "codemode");
		rig.record({ type: "tool_execution_start", toolCallId: "p1", toolName: "codemode", args: { command: "p1" } });
		for (const id of ["p1/1", "p1/2"])
			rig.record({
				type: "tool_execution_start",
				toolCallId: id,
				toolName: "read",
				args: { id },
				parentToolCallId: "p1",
			});
		rig.record({ type: "tool_execution_end", toolCallId: "p1/1", toolName: "read", result: "r1", isError: false });
		const nested = await rig.calls();
		rig.record({ type: "tool_execution_end", toolCallId: "p1", toolName: "codemode", result: "ok", isError: false });
		rig.toolResult("p1", "codemode", "ok");
		const settled = await rig.calls();
		const parentKey = nested.calls.find((entry) => entry.toolCallId === "p1")?.runtimeItemKey;
		expect(nested.calls.filter((entry) => entry.parentKey === parentKey).map((entry) => entry.toolCallId)).toEqual([
			"p1/1",
			"p1/2",
		]);
		expect(nested.calls.find((entry) => entry.toolCallId === "p1/1")?.owningMessageId).toBeNull();
		const row = (await rig.lane.readSettled(settled.root)).settledMessages.find((each) => each.role === "toolResult");
		expect(row?.call).toMatchObject({
			runtimeItemKey: parentKey,
			nestedCalls: { calls: [{ toolCallId: "p1/1", outcome: { kind: "result", isError: false } }], complete: false },
		});
		expect(settled.calls.map((entry) => [entry.toolCallId, entry.phase, entry.join])).toEqual([
			["p1/2", "executing", "pending"],
		]);
		rig.record({ type: "tool_execution_end", toolCallId: "p1/2", toolName: "read", result: "r2", isError: false });
		expect((await rig.calls()).calls[0]).toMatchObject({ phase: "completed-awaiting-entry", join: "carrierless" });
		rig.lane.release(nested.root);
		rig.lane.release(settled.root);
	} finally {
		await rig.close();
	}
});

it("senpi#4278 a repeated nested id mints a fresh key and counts the reuse", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		rig.record({ type: "tool_execution_start", toolCallId: "p1", toolName: "codemode", args: {} });
		const first = rig.record({
			type: "tool_execution_start",
			toolCallId: "p1/1",
			toolName: "read",
			args: {},
			parentToolCallId: "p1",
		});
		rig.record({ type: "tool_execution_end", toolCallId: "p1/1", toolName: "read", result: "a", isError: false });
		const second = rig.record({
			type: "tool_execution_start",
			toolCallId: "p1/1",
			toolName: "read",
			args: {},
			parentToolCallId: "p1",
		});
		const view = await rig.calls();
		const keys = view.calls.filter((entry) => entry.toolCallId === "p1/1").map((entry) => entry.runtimeItemKey);
		expect(keys).toEqual([
			`${view.root.sessionEpoch}:${first?.sequence}.0`,
			`${view.root.sessionEpoch}:${second?.sequence}.0`,
		]);
		expect(view.counters.reused).toBe(1);
		rig.lane.release(view.root);
	} finally {
		await rig.close();
	}
});

it("RULING-13 an unannounced start has a null owning message and a parentKey resolved from parentToolCallId", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		const parent = rig.record({ type: "tool_execution_start", toolCallId: "u1", toolName: "codemode", args: {} });
		const child = { type: "tool_execution_start", toolName: "read", args: {} };
		rig.record({ ...child, toolCallId: "u1/1", parentToolCallId: "u1" });
		rig.record({ ...child, toolCallId: "o1", parentToolCallId: "ghost" });
		const live = await rig.calls();
		const parentKey = `${live.root.sessionEpoch}:${parent?.sequence}.0`;
		expect(live.calls.map((entry) => [entry.toolCallId, entry.owningMessageId, entry.parentKey])).toEqual([
			["u1", null, null],
			["u1/1", null, parentKey],
			["o1", null, null],
		]);
		const end = { type: "tool_execution_end", toolName: "read", result: "r", isError: false };
		rig.record({ ...end, toolCallId: "u1/1" });
		rig.record({ ...end, toolCallId: "u1" });
		rig.toolResult("u1", "codemode", "r");
		const settled = await rig.calls();
		const row = (await rig.lane.readSettled(settled.root)).settledMessages.find((each) => each.role === "toolResult");
		expect(row?.call).toMatchObject({
			runtimeItemKey: parentKey,
			owningMessageId: null,
			parentKey: null,
			nestedCalls: { calls: [{ toolCallId: "u1/1", owningMessageId: null, parentKey }], complete: true, omitted: 0 },
		});
		expect(settled.calls.map((entry) => entry.toolCallId)).toEqual(["o1"]);
		rig.lane.release(live.root);
		rig.lane.release(settled.root);
	} finally {
		await rig.close();
	}
});
