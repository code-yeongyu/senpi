import { expect, it } from "vitest";
import { NESTED_PROJECTION_LIMIT } from "../../../src/modes/rpc/compact-call-model.ts";
import { callsRig } from "./4272-calls-support.ts";

// Part of #4272, R3.C3.3 (RULING-13 Q5, RULING-49): a parent projection bounded at NESTED_PROJECTION_LIMIT names how
// many completed children it left out, so a truncated projection never reads like one still waiting on a child.

const start = (toolCallId: string, parentToolCallId?: string) => ({
	type: "tool_execution_start",
	toolCallId,
	toolName: parentToolCallId === undefined ? "codemode" : "read",
	args: { id: toolCallId },
	...(parentToolCallId === undefined ? {} : { parentToolCallId }),
});
const end = (toolCallId: string) => ({
	type: "tool_execution_end",
	toolCallId,
	toolName: "read",
	result: "r",
	isError: false,
});

async function settledNested(completed: number, executing = 0) {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		rig.record(start("p1"));
		for (let index = 0; index < completed + executing; index++) {
			rig.record(start(`p1/${index}`, "p1"));
			if (index < completed) rig.record(end(`p1/${index}`));
		}
		rig.record(end("p1"));
		rig.toolResult("p1", "codemode", "p");
		const root = rig.lane.freeze();
		const row = (await rig.lane.readSettled(root)).settledMessages.find((each) => each.role === "toolResult");
		rig.lane.release(root);
		const nested = row?.call?.nestedCalls;
		return { calls: nested?.calls.length, complete: nested?.complete, omitted: nested?.omitted };
	} finally {
		await rig.close();
	}
}

it("RULING-49 one completed child past the limit is counted as omitted and the projection is incomplete", async () => {
	expect(await settledNested(NESTED_PROJECTION_LIMIT + 1)).toEqual({
		calls: NESTED_PROJECTION_LIMIT,
		complete: false,
		omitted: 1,
	});
});

it("RULING-49 exactly the limit of completed children omits none and is complete", async () => {
	expect(await settledNested(NESTED_PROJECTION_LIMIT)).toEqual({
		calls: NESTED_PROJECTION_LIMIT,
		complete: true,
		omitted: 0,
	});
});

it("RULING-49 a child still executing past the limit is incomplete with nothing omitted, unlike truncation", async () => {
	expect(await settledNested(NESTED_PROJECTION_LIMIT, 1)).toEqual({
		calls: NESTED_PROJECTION_LIMIT,
		complete: false,
		omitted: 0,
	});
});
