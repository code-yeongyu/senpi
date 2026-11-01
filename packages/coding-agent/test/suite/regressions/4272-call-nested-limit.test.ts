import { expect, it } from "vitest";
import { callsRig } from "./4272-calls-support.ts";

// Part of #4272, R3.C3.3 (RULING-13 Q5, RULING-49, RULING-60 Q3): a parent projection carries every completed child
// (the bound is the value page, 128 descriptors and 64 KiB each, never a total count), so `omitted` is 0 on every path
// that projects, and only a child still executing makes the projection incomplete.

const PAST_THE_OLD_LIMIT = 257;

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

it("RULING-60 Q3 completed children past the old 256 cap are all projected: nothing omitted, the projection complete", async () => {
	expect(await settledNested(PAST_THE_OLD_LIMIT)).toEqual({
		calls: PAST_THE_OLD_LIMIT,
		complete: true,
		omitted: 0,
	});
});

it("RULING-49 a child still executing is incomplete with nothing omitted, unlike truncation", async () => {
	expect(await settledNested(PAST_THE_OLD_LIMIT, 1)).toEqual({
		calls: PAST_THE_OLD_LIMIT,
		complete: false,
		omitted: 0,
	});
});
