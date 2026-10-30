import { fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { announced, callsRig } from "./4272-calls-support.ts";

// Part of #4272, R3.C3.3 (RULING-13 Q2-Q4, Q7): an outstanding call's terminal: its carrier's settle with a full
// projection, a not-executed turn end, or abandonment at settle.

it("Q2 Q7 the carrier's settle retires the call with a full projection on the S05 row in the same step", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		const { owner, started } = await announced(rig, "c1");
		rig.record({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "c1" } });
		rig.record({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: "done", isError: false });
		const live = await rig.calls();
		rig.toolResult("c1", "bash", "done");
		const settled = await rig.calls();
		const row = (await rig.lane.readSettled(settled.root)).settledMessages.find((each) => each.role === "toolResult");
		const key = `${live.root.sessionEpoch}:${started?.sequence}.0`;
		expect(live.calls.map((entry) => entry.runtimeItemKey)).toEqual([key]);
		expect(settled.calls).toEqual([]);
		expect(settled.sequence).toBe(settled.root.sequence);
		expect(row).toMatchObject({
			runtimeItemKey: key,
			call: {
				runtimeItemKey: key,
				toolCallId: "c1",
				turnId: started?.turnId,
				owningMessageId: owner.messageId,
				contentIndex: 0,
				parentKey: null,
				requestedName: "bash",
				resolvedName: "bash",
				input: { announced: { command: "c1" }, started: { command: "c1" }, prepared: null },
				startSequence: live.calls[0]?.startSequence,
				outcome: { kind: "result", isError: false, source: "execution_end" },
				nestedCalls: { calls: [], complete: true, omitted: 0 },
			},
		});
		expect(rig.lane.storageStatus().residentSettledKeys).toBeGreaterThan(0);
		rig.lane.release(live.root);
		rig.lane.release(settled.root);
	} finally {
		await rig.close();
	}
});

it("Q3 a never-started call retires at turn_end as an explicit not-executed terminal, never silently", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		const owner = rig.start();
		const call = fauxToolCall("bash", { command: "never" }, { id: "n1" });
		rig.toolStart(owner, 0, call, "bash");
		rig.toolEnd(owner, 0, call, "bash");
		rig.end(owner, [call], "error");
		const before = await rig.calls();
		rig.record({ type: "turn_end", message: {}, toolResults: [] });
		const after = await rig.calls();
		expect(before.calls[0]).toMatchObject({ phase: "awaiting-execution", outcome: null });
		expect(after.calls[0]).toMatchObject({
			runtimeItemKey: before.calls[0]?.runtimeItemKey,
			phase: "completed-awaiting-entry",
			outcome: { kind: "not-executed" },
			join: "carrierless",
		});
		expect(after.counters.carrierless).toBe(1);
		rig.record({ type: "agent_settled" });
		expect((await rig.calls()).calls[0]?.outcome).toEqual({ kind: "not-executed" });
		rig.lane.release(before.root);
		rig.lane.release(after.root);
	} finally {
		await rig.close();
	}
});

it("Q4 a started call with no carrier is abandoned at agent_settled and a late real end replaces the outcome", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		rig.record({ type: "tool_execution_start", toolCallId: "br", toolName: "bash", args: { command: "x" } });
		rig.record({ type: "turn_end", message: {}, toolResults: [] });
		rig.record({ type: "agent_end", messages: [] });
		rig.record({ type: "agent_settled" });
		const abandoned = await rig.calls();
		const late = rig.record({
			type: "tool_execution_end",
			toolCallId: "br",
			toolName: "bash",
			result: "r",
			isError: true,
		});
		const ended = await rig.calls();
		expect(abandoned.calls[0]).toMatchObject({
			owningMessageId: null,
			join: "carrierless",
			outcome: { kind: "abandoned" },
		});
		expect(late).toBeDefined();
		expect(ended.calls[0]).toMatchObject({
			phase: "completed-awaiting-entry",
			join: "carrierless",
			result: "r",
			outcome: { kind: "result", isError: true, source: "execution_end" },
		});
		expect(ended.counters).toMatchObject({ live: 1, carrierless: 1 });
		rig.lane.release(abandoned.root);
		rig.lane.release(ended.root);
	} finally {
		await rig.close();
	}
});
