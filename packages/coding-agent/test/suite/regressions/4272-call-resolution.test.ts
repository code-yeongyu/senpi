import { fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { type CallsRig, callsRig } from "./4272-calls-support.ts";

// Part of #4272, senpi#4278: every per-id record resolves to the oldest call under its id that can still take it.

type Probe = "start" | "update" | "hook" | "end" | "settle";
type Scenario = "single" | "overlap" | "afterTerminal";
const PROBES: readonly Probe[] = ["start", "update", "hook", "end", "settle"];
const SCENARIOS: readonly Scenario[] = ["single", "overlap", "afterTerminal"];

const bridge = (id: string) => ({ type: "tool_execution_start", toolCallId: id, toolName: "read", args: { id } });
const endOf = (id: string, result: string) => ({
	type: "tool_execution_end",
	toolCallId: id,
	toolName: "read",
	result,
	isError: false,
});
function announce(rig: CallsRig, ids: readonly string[]): void {
	const owner = rig.start();
	const calls = ids.map((id, contentIndex) => {
		const call = fauxToolCall("read", { id }, { id });
		rig.toolStart(owner, contentIndex, call, "read");
		rig.toolEnd(owner, contentIndex, call, "read");
		return call;
	});
	rig.end(owner, calls);
}

/** The calls on the table before the probe, by creation; `start` probes need announced blocks, the rest bridged starts. */
const SETUP: Record<Scenario, Record<"start" | "exec", (rig: CallsRig) => void>> = {
	single: {
		start: (rig) => announce(rig, ["n1"]),
		exec: (rig) => rig.record(bridge("n1")),
	},
	overlap: {
		start: (rig) => {
			announce(rig, ["n1", "n1"]);
			rig.record(bridge("n1"));
		},
		exec: (rig) => {
			rig.record(bridge("n1"));
			rig.record(bridge("n1"));
		},
	},
	afterTerminal: {
		start: (rig) => {
			announce(rig, ["n1"]);
			rig.record(bridge("n1"));
			rig.record(endOf("n1", "a"));
			announce(rig, ["n1"]);
		},
		exec: (rig) => {
			rig.record(bridge("n1"));
			rig.record(endOf("n1", "a"));
			rig.record(bridge("n1"));
		},
	},
};

const PROBE: Record<Probe, (rig: CallsRig) => void> = {
	start: (rig) => rig.record(bridge("n1")),
	update: (rig) =>
		rig.record({ type: "tool_execution_update", toolCallId: "n1", toolName: "read", args: {}, partialResult: "p" }),
	hook: (rig) =>
		rig.record({
			type: "tool_hook_status",
			hookRunId: "n1:PreToolUse:0",
			hookName: "PreToolUse",
			toolName: "read",
			toolCallId: "n1",
			extensionPath: "ext",
			statusMessage: "s",
			startedAt: 1,
			phase: "start",
		}),
	end: (rig) => rig.record(endOf("n1", "b")),
	settle: (rig) => rig.toolResult("n1", "read", "r"),
};

/** Which call (index by creation) each record lands on: the oldest one that can still take it, own turn first. */
const EXPECTED: Record<Probe, Record<Scenario, number>> = {
	start: { single: 0, overlap: 1, afterTerminal: 1 },
	update: { single: 0, overlap: 0, afterTerminal: 1 },
	hook: { single: 0, overlap: 0, afterTerminal: 1 },
	end: { single: 0, overlap: 0, afterTerminal: 1 },
	settle: { single: 0, overlap: 0, afterTerminal: 0 },
};

/** The index of the one pre-existing call the probe changed or retired; "new" when it minted a call instead. */
async function landing(probe: Probe, scenario: Scenario): Promise<number | "new" | readonly number[]> {
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		SETUP[scenario][probe === "start" ? "start" : "exec"](rig);
		const before = await rig.calls();
		PROBE[probe](rig);
		const after = await rig.calls();
		const keys = before.calls.map((entry) => entry.runtimeItemKey);
		const was = new Map(before.calls.map((entry) => [entry.runtimeItemKey, JSON.stringify(entry)]));
		const now = new Map(after.calls.map((entry) => [entry.runtimeItemKey, JSON.stringify(entry)]));
		const changed = keys.filter((key) => now.get(key) !== was.get(key)).map((key) => keys.indexOf(key));
		rig.lane.release(before.root);
		rig.lane.release(after.root);
		if ([...now.keys()].some((key) => !was.has(key))) return "new";
		return changed.length === 1 ? changed[0] : changed;
	} finally {
		await rig.close();
	}
}

it("senpi#4278 every per-id record (start join, update, hook, end, settle) lands on the oldest call that can take it", async () => {
	const rows: [Probe, Scenario, Awaited<ReturnType<typeof landing>>][] = [];
	for (const probe of PROBES)
		for (const scenario of SCENARIOS) rows.push([probe, scenario, await landing(probe, scenario)]);
	expect(rows).toEqual(
		PROBES.flatMap((probe) => SCENARIOS.map((scenario) => [probe, scenario, EXPECTED[probe][scenario]])),
	);
});
