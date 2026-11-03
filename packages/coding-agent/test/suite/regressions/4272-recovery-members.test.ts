import { afterEach, expect, it, vi } from "vitest";
import { CompactValues } from "../../../src/modes/rpc/compact-values.ts";
import { callsRig } from "./4272-calls-support.ts";
import { memberOf, produced } from "./4272-catalog-read-support.ts";
import { recoveryRig } from "./4272-recovery-support.ts";

// Part of #4272 (S10b, R4.B2, T1): the active and calls adapters and the settled terminal member read as the whole-view
// readers do, every value inline (text, slots, payload, paged call projection) and no storage id in any member.

afterEach(() => {
	vi.restoreAllMocks();
});

it("T1 a failed terminal is a settled member with its status, error, payload and call projection; the outstanding call that still executes is a calls member with its slots inline", async () => {
	// Given: one call still executing with hook and progress slots, and one toolResult whose write failed
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		rig.record({ type: "tool_execution_start", toolCallId: "done", toolName: "read", args: { p: 1 } });
		rig.record({
			type: "tool_execution_end",
			toolCallId: "done",
			toolName: "read",
			result: { ok: 1 },
			isError: true,
		});
		const carrier = rig.toolResult("done", "read", "boom", true);
		rig.lane.accept({ type: "transcript_write_failed", errorMessage: "EACCES" }, carrier);
		rig.record({ type: "tool_execution_start", toolCallId: "live", toolName: "bash", args: { cmd: "x" } });
		rig.record({ type: "tool_hook_status", toolCallId: "live", status: "running" });
		rig.record({ type: "tool_execution_update", toolCallId: "live", args: { cmd: "x" }, partialResult: { n: 2 } });
		await rig.lane.idle();
		const root = rig.lane.freeze();
		const whole = await rig.lane.readSettled(root);
		const live = (await rig.lane.readCurrentCalls(root)).calls.find((call) => call.toolCallId === "live");
		// When: the cut is cataloged
		const { texts, peak } = await produced(rig.lane, root);
		// Then: the settled member is the terminal row as the whole-view reader sees it, call projection included
		const row = whole.settledMessages[0];
		const settledId = memberOf("message", row?.terminalSequence ?? expect.unreachable());
		expect(JSON.parse(texts.get(`settled/${settledId}`) ?? "")).toEqual({
			messageId: carrier.messageId,
			turnId: row?.turnId,
			terminalSequence: row?.terminalSequence,
			role: "toolResult",
			runtimeItemKey: row?.runtimeItemKey,
			entryId: null,
			status: "failed",
			error: { errorMessage: "EACCES" },
			payload: { terminal: row?.terminal, correlation: row?.correlation },
			call: row?.call,
		});
		// And: the executing call is a calls member with every slot's value and no storage reference
		expect(live).toBeDefined();
		const calls = [...texts.keys()].filter((key) => key.startsWith("calls/"));
		expect(calls).toHaveLength(1);
		expect(JSON.parse(texts.get(calls[0] ?? "") ?? "")).toEqual({
			...live,
			raw: null,
			hook: { type: "tool_hook_status", toolCallId: "live", status: "running" },
			progress: { n: 2 },
			result: null,
		});
		expect(texts.get(calls[0] ?? "")).not.toMatch(/"owner"/);
		expect(peak, "one value page resident while a member streams").toBe(1);
		rig.lane.release(root);
	} finally {
		await rig.close();
	}
});

it("#4568 LOW 2 an outstanding call header streams through the catalog's value reader with one page resident; no header is assembled", async () => {
	// Given: one executing call whose arguments are 200,000 code units, so its header spans many value pages
	const rig = await callsRig();
	try {
		const big = "y".repeat(200_000);
		rig.record({ type: "turn_start" });
		rig.record({ type: "tool_execution_start", toolCallId: "big", toolName: "bash", args: { cmd: big } });
		await rig.lane.idle();
		const root = rig.lane.freeze();
		const live = (await rig.lane.readCurrentCalls(root)).calls[0];
		// When: the cut is cataloged while every whole-value read is recorded
		const read = vi.spyOn(CompactValues.prototype, "read");
		const { texts, peak } = await produced(rig.lane, root);
		const assembled = await Promise.all(read.mock.results.map((result) => result.value));
		read.mockRestore();
		// Then: the member is the header with its arguments inline, and no read assembled a call header
		const calls = [...texts.keys()].filter((key) => key.startsWith("calls/"));
		expect(JSON.parse(texts.get(calls[0] ?? "") ?? "")).toEqual({
			...live,
			raw: null,
			hook: null,
			progress: null,
			result: null,
		});
		const headers = assembled.filter((value) => typeof value === "object" && value !== null && "phase" in value);
		expect(headers, "the header walks; it is never read whole").toEqual([]);
		expect(peak, "one value page resident while the header streams").toBe(1);
		rig.lane.release(root);
	} finally {
		await rig.close();
	}
});

it("T1 an active assistant message is a member with its fields, ordered blocks and block text, read with bounded pages", async () => {
	// Given: one live assistant message whose text block streamed 100,000 code units
	const rig = recoveryRig();
	const text = "x".repeat(100_000);
	rig.producer().blockDelta("text", 0, text, 0);
	await rig.lane.idle();
	const root = rig.lane.freeze();
	const view = (await rig.lane.readCurrentActive(root))[0];
	// When: the cut is cataloged
	const { texts, peak } = await produced(rig.lane, root);
	// Then: the member is the message as the live view reads it, every block's text inline
	expect(JSON.parse(texts.get(`active/${memberOf("message", 0)}`) ?? "")).toEqual({
		messageId: "message-1",
		fields: view?.fields,
		correlation: null,
		blocks: [
			{
				contentIndex: 0,
				kind: "text",
				text,
				seeded: { type: "text", phase: "open", parsedThrough: 0, fields: { type: "text" }, signature: "" },
			},
		],
	});
	expect(peak).toBeLessThanOrEqual(2);
	rig.lane.release(root);
	await rig.lane.idle();
});
