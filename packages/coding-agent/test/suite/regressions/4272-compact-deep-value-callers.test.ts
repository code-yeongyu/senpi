import { fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import type { OutstandingCall } from "../../../src/modes/rpc/compact-call-model.ts";
import { CompactCallTable, creationOf } from "../../../src/modes/rpc/compact-call-table.ts";
import { CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import { CompactValues } from "../../../src/modes/rpc/compact-values.ts";
import { memoryIo, spoolRoot } from "../compact-storage-support.ts";
import { callsRig } from "./4272-calls-support.ts";

// senpi#4272 RULING-59, review LOWs on #4557: callers of the uncapped owner. A value the engine cannot serialize
// must not leave owned pages behind, and every whole-value read under a cut lease rechecks it between page reads.
// senpi#4956: BigInt fails JSON.stringify deterministically, unlike nesting beyond a runtime-dependent stack limit.

async function withTable(run: (table: CompactCallTable) => void) {
	const root = await spoolRoot();
	const store = new CompactContentStore({ dir: root.dir, io: memoryIo() });
	try {
		run(new CompactCallTable(store));
		await store.idle();
		expect(store.status().structuredBytes, "nothing stays owned").toEqual({ resident: 0, spilled: 0, pinned: 0 });
		expect(store.text.residentNodes).toBe(0);
	} finally {
		await store.retire();
		await root.cleanup();
	}
}

it("a call slot the engine cannot serialize throws before anything is owned", async () => {
	await withTable((table) => {
		expect(() => table.own(1n)).toThrowError(TypeError);
	});
});

it("a call header the engine cannot serialize leaves the table and the store unchanged", async () => {
	await withTable((table) => {
		const call: OutstandingCall = {
			runtimeItemKey: "e:1.0",
			turnId: "t1",
			toolCallId: "c1",
			owningMessageId: null,
			contentIndex: null,
			parentKey: null,
			phase: "executing",
			join: "pending",
			startSequence: null,
			startedAtMs: null,
			requestedName: "bash",
			resolvedName: "bash",
			seed: 1n,
			raw: null,
			input: { announced: null, started: null, prepared: null },
			correlation: null,
			hook: null,
			progress: null,
			result: null,
			outcome: null,
		};
		expect(() => table.put(call, creationOf(call))).toThrowError(TypeError);
		expect(table.root.header === undefined && table.root.ref === undefined, "the root is unchanged").toBe(true);
		expect(table.snapshot().live).toBe(0);
	});
});

it("call slots, the lifecycle and seeded fields are read with the cut's lease check", async () => {
	const rig = await callsRig();
	const read = vi.spyOn(CompactValues.prototype, "read");
	try {
		rig.record({ type: "turn_start" });
		rig.record({ type: "session_lifecycle", sessionId: "s", lifecycle: { phase: "x".repeat(10_000) } });
		const owner = rig.start();
		const call = fauxToolCall("bash", { command: "ls" }, { id: "c1" });
		rig.toolStart(owner, 0, call, "bash");
		rig.record({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
		rig.record({
			type: "tool_execution_update",
			toolCallId: "c1",
			toolName: "bash",
			args: { command: "ls" },
			partialResult: { tail: "y".repeat(10_000) },
		});
		const root = rig.lane.freeze();
		read.mockClear();
		const calls = await rig.lane.readCurrentCalls(root);
		const components = await rig.lane.readCurrentComponents(root);
		const active = await rig.lane.readCurrentActive(root);
		expect(calls.calls[0]?.progress).toEqual({ tail: "y".repeat(10_000) });
		expect(components.lifecycle).toMatchObject({ lifecycle: { phase: "x".repeat(10_000) } });
		expect(active[0]?.fields).toBeDefined();
		const unchecked = read.mock.calls.filter(([, valid]) => typeof valid !== "function");
		expect(read.mock.calls.length).toBeGreaterThan(0);
		expect(unchecked).toEqual([]);
		rig.lane.release(root);
	} finally {
		read.mockRestore();
		await rig.close();
	}
});
