import { fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { callsRig } from "./4272-calls-support.ts";

// Part of #4272, R3.C3.2-C3.3 (RULING-13, X07): progress and hook state are current values, never a replay list.

it("T3b progress keeps only the latest value with constant slot bytes across 1,000 updates", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		const owner = rig.start();
		const call = fauxToolCall("bash", { command: "ls" }, { id: "c1" });
		rig.toolStart(owner, 0, call, "bash");
		rig.toolEnd(owner, 0, call, "bash");
		rig.end(owner, [call]);
		rig.record({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
		const update = (n: number) => ({
			type: "tool_execution_update",
			toolCallId: "c1",
			toolName: "bash",
			args: { command: "ls" },
			partialResult: { tail: String(n).padStart(6, "0") },
		});
		rig.record(update(1));
		const first = await rig.calls();
		rig.record(update(2));
		const second = await rig.calls();
		const slotBytes = second.counters.slotBytes;
		for (let n = 3; n <= 1002; n++) rig.record(update(n));
		const last = await rig.calls();
		expect(first.calls[0]?.progress).toEqual({ tail: "000001" });
		expect(second.calls[0]?.progress).toEqual({ tail: "000002" });
		expect((await rig.calls(first.root)).calls[0]?.progress, "an earlier cut is unchanged").toEqual({
			tail: "000001",
		});
		expect(last.calls[0]?.progress).toEqual({ tail: "001002" });
		expect(last.counters.slotBytes).toBe(slotBytes);
		expect(last.counters.progressReplacements).toBe(1002);
		expect(last.calls[0]?.input.prepared).toEqual({ command: "ls" });
		for (const cut of [first, second, last]) rig.lane.release(cut.root);
	} finally {
		await rig.close();
	}
});

it("T3h hook status keeps only the latest record for a known call and an unknown id creates nothing", async () => {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		const owner = rig.start();
		const call = fauxToolCall("bash", { command: "ls" }, { id: "c1" });
		rig.toolStart(owner, 0, call, "bash");
		rig.toolEnd(owner, 0, call, "bash");
		rig.end(owner, [call]);
		rig.record({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
		const hook = (phase: string, statusMessage: string, toolCallId = "c1") => ({
			type: "tool_hook_status",
			hookRunId: `${toolCallId}:PreToolUse:0`,
			hookName: "PreToolUse",
			toolName: "bash",
			toolCallId,
			extensionPath: "ext",
			statusMessage,
			startedAt: 1,
			phase,
		});
		rig.record(hook("start", "checking"));
		rig.record(hook("update", "still checking"));
		rig.record(hook("start", "codemode", "codemode-abc"));
		const view = await rig.calls();
		expect(view.calls).toHaveLength(1);
		expect(view.calls[0]?.hook).toMatchObject({ phase: "update", statusMessage: "still checking" });
		expect(view.counters.ignored).toEqual({ unknown: 1, late: 0 });
		rig.lane.release(view.root);
	} finally {
		await rig.close();
	}
});
