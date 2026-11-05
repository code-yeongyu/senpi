import { fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { type CallsRig, callsRig } from "./4272-calls-support.ts";

// Part of #4272, R3.C3.3 (RULING-13 Q3-Q5): the sweep reaches nested calls, carriers settle in creation order,
// and a projection is complete only when every descendant rode on it.

const TERMINAL = "completed-awaiting-entry";
const start = (toolCallId: string, parentToolCallId?: string) => ({
	type: "tool_execution_start",
	toolCallId,
	toolName: parentToolCallId === undefined ? "codemode" : "read",
	args: { id: toolCallId },
	...(parentToolCallId === undefined ? {} : { parentToolCallId }),
});
const end = (toolCallId: string, result: string) => ({
	type: "tool_execution_end",
	toolCallId,
	toolName: "read",
	result,
	isError: false,
});
const runSettled = (rig: CallsRig) => {
	rig.record({ type: "turn_end", message: {}, toolResults: [] });
	rig.record({ type: "agent_end", messages: [] });
	return rig.record({ type: "agent_settled" });
};
const shape = (entry: { toolCallId: string | null; phase: string; join: string; outcome: { kind: string } | null }) =>
	[entry.toolCallId, entry.phase, entry.join, entry.outcome?.kind ?? null] as const;
async function toolResultKeys(rig: CallsRig, root: Parameters<CallsRig["lane"]["readSettled"]>[0]) {
	const { settledMessages } = await rig.lane.readSettled(root);
	return settledMessages
		.filter((row) => row.role === "toolResult")
		.sort((a, b) => a.terminalSequence - b.terminalSequence)
		.map((row) => row.runtimeItemKey);
}

it("Q4 Q5 a nested call still executing when the run settles is abandoned and carrierless, never left silent", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		rig.record(start("p1"));
		rig.record(start("p1/1", "p1"));
		rig.record(end("p1", "ok"));
		rig.toolResult("p1", "codemode", "ok");
		const orphaned = await rig.calls();
		const swept = runSettled(rig);
		const after = await rig.calls();
		expect(orphaned.calls.map(shape)).toEqual([["p1/1", "executing", "pending", null]]);
		expect(swept, "the sweep changes the nested call").toBeDefined();
		expect(after.calls.map(shape)).toEqual([["p1/1", TERMINAL, "carrierless", "abandoned"]]);
		expect(after.counters).toMatchObject({ live: 1, carrierless: 1 });
		rig.lane.release(orphaned.root);
		rig.lane.release(after.root);
	} finally {
		await rig.close();
	}
});

it("Q4 a late end for the child of an abandoned parent replaces its outcome and stays carrierless", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		rig.record(start("p1"));
		rig.record(start("p1/1", "p1"));
		runSettled(rig);
		const swept = await rig.calls();
		const late = rig.record(end("p1/1", "r"));
		const ended = await rig.calls();
		expect(swept.calls.map(shape)).toEqual([
			["p1", TERMINAL, "carrierless", "abandoned"],
			["p1/1", TERMINAL, "carrierless", "abandoned"],
		]);
		expect(late, "a late real end still replaces an abandoned outcome").toBeDefined();
		expect(ended.calls.map(shape)).toEqual([
			["p1", TERMINAL, "carrierless", "abandoned"],
			["p1/1", TERMINAL, "carrierless", "result"],
		]);
		expect(ended.calls[1]).toMatchObject({
			result: "r",
			outcome: { kind: "result", isError: false, source: "execution_end" },
		});
		expect(ended.counters).toMatchObject({ live: 2, carrierless: 2 });
		rig.lane.release(swept.root);
		rig.lane.release(ended.root);
	} finally {
		await rig.close();
	}
});

it("Q3 Q4 a child ending under a parent that is carrierless but still resident is an orphan", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		const owner = rig.start();
		const call = fauxToolCall("codemode", { id: "p1" }, { id: "p1" });
		rig.toolStart(owner, 0, call, "codemode");
		rig.toolEnd(owner, 0, call, "codemode");
		rig.end(owner, [call]);
		rig.record(start("p1/1", "p1"));
		rig.record({ type: "turn_end", message: {}, toolResults: [] });
		const swept = await rig.calls();
		rig.record(end("p1/1", "r"));
		const ended = await rig.calls();
		expect(swept.calls.map(shape)).toEqual([
			["p1", TERMINAL, "carrierless", "not-executed"],
			["p1/1", "executing", "pending", null],
		]);
		expect(ended.calls.map(shape)).toEqual([
			["p1", TERMINAL, "carrierless", "not-executed"],
			["p1/1", TERMINAL, "carrierless", "result"],
		]);
		rig.lane.release(swept.root);
		rig.lane.release(ended.root);
	} finally {
		await rig.close();
	}
});

it("senpi#4278 overlapping reused ids settle in creation order, each carrier retiring the call it belongs to", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		const first = rig.record(start("n1"));
		const second = rig.record(start("n1"));
		rig.record(end("n1", "a"));
		rig.record(end("n1", "b"));
		rig.toolResult("n1", "codemode", "a");
		const one = await rig.calls();
		rig.toolResult("n1", "codemode", "b");
		const two = await rig.calls();
		const epoch = one.root.sessionEpoch;
		const firstKey = `${epoch}:${first?.sequence}.0`;
		const secondKey = `${epoch}:${second?.sequence}.0`;
		expect(one.calls.map((entry) => entry.runtimeItemKey)).toEqual([secondKey]);
		expect(await toolResultKeys(rig, one.root)).toEqual([firstKey]);
		expect(two.calls).toEqual([]);
		expect(await toolResultKeys(rig, two.root)).toEqual([firstKey, secondKey]);
		expect(two.counters).toMatchObject({ reused: 1, carrierless: 0, ignored: { unknown: 0, late: 0 } });
		rig.lane.release(one.root);
		rig.lane.release(two.root);
	} finally {
		await rig.close();
	}
});

it("Q5 a projection is complete only when every grandchild rode on it; an executing grandchild stays live", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		rig.record(start("p1"));
		rig.record(start("p1/c", "p1"));
		rig.record(start("p1/c/g", "p1/c"));
		rig.record(end("p1/c", "c"));
		rig.record(end("p1", "p"));
		const live = await rig.calls();
		rig.toolResult("p1", "codemode", "p");
		const settled = await rig.calls();
		const keyOf = (id: string) => live.calls.find((entry) => entry.toolCallId === id)?.runtimeItemKey;
		const row = (await rig.lane.readSettled(settled.root)).settledMessages.find((each) => each.role === "toolResult");
		expect(row?.call).toMatchObject({
			runtimeItemKey: keyOf("p1"),
			nestedCalls: {
				calls: [{ runtimeItemKey: keyOf("p1/c"), nestedCalls: { calls: [], complete: false, omitted: 0 } }],
				complete: false,
				omitted: 0,
			},
		});
		expect(settled.calls.map(shape)).toEqual([["p1/c/g", "executing", "pending", null]]);
		rig.record(end("p1/c/g", "g"));
		expect((await rig.calls()).calls.map(shape)).toEqual([["p1/c/g", TERMINAL, "carrierless", "result"]]);
		rig.lane.release(live.root);
		rig.lane.release(settled.root);
	} finally {
		await rig.close();
	}
});

it("Q5 a completed grandchild rides nested on its parent's projection and leaves the table with it", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		rig.record(start("p1"));
		rig.record(start("p1/c", "p1"));
		rig.record(start("p1/c/g", "p1/c"));
		rig.record(end("p1/c/g", "g"));
		rig.record(end("p1/c", "c"));
		rig.record(end("p1", "p"));
		const live = await rig.calls();
		rig.toolResult("p1", "codemode", "p");
		const settled = await rig.calls();
		const keyOf = (id: string) => live.calls.find((entry) => entry.toolCallId === id)?.runtimeItemKey;
		const row = (await rig.lane.readSettled(settled.root)).settledMessages.find((each) => each.role === "toolResult");
		expect(row?.call).toMatchObject({
			runtimeItemKey: keyOf("p1"),
			nestedCalls: {
				calls: [
					{
						runtimeItemKey: keyOf("p1/c"),
						parentKey: keyOf("p1"),
						nestedCalls: {
							calls: [
								{
									runtimeItemKey: keyOf("p1/c/g"),
									parentKey: keyOf("p1/c"),
									nestedCalls: { calls: [], complete: true, omitted: 0 },
								},
							],
							complete: true,
							omitted: 0,
						},
					},
				],
				complete: true,
				omitted: 0,
			},
		});
		expect(settled.calls).toEqual([]);
		expect(settled.counters.live).toBe(0);
		rig.lane.release(live.root);
		rig.lane.release(settled.root);
	} finally {
		await rig.close();
	}
});
