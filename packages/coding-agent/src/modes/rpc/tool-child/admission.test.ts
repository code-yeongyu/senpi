import { describe, expect, it } from "vitest";
import { HostCallAdmission, hostCallCapacity, JobAdmission } from "./admission.ts";
import { encodeFrame, FrameDecoder } from "./codec.ts";
import { isLossy, TraceBudget, WakeAdmission, WakeAdmissionError } from "./flow-control.ts";
import { LOSSY_FRAME_TYPES, TOOL_CHILD_LIMITS } from "./protocol.ts";
import { isToolChildMessage } from "./protocol-guard.ts";

const callId = (index: number): string => `call-${index}`;

function submitMany(admission: HostCallAdmission, count: number) {
	const states: { active: number; waiting: number; refused: string[] } = { active: 0, waiting: 0, refused: [] };
	for (let index = 1; index <= count; index += 1) {
		const decision = admission.submit(callId(index));
		if (decision.state === "refused") states.refused.push(decision.frame.callId);
		else states[decision.state] += 1;
	}
	return states;
}

/** One loop turn: enough for an already-resolved promise to settle, never a timed wait. */
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function tracked(promise: Promise<void>) {
	const state = { settled: false };
	promise.then(() => {
		state.settled = true;
	});
	return state;
}

describe("host-call admission", () => {
	it("has one capacity: 8 active + 256 waiting = 264", () => {
		expect(hostCallCapacity()).toBe(264);
		expect(hostCallCapacity()).toBe(TOOL_CHILD_LIMITS.HOST_CALL_ACTIVE + TOOL_CHILD_LIMITS.HOST_CALL_WAITING);
	});

	it("264 concurrent submissions -> 8 active, 256 waiting, 0 refused", () => {
		const admission = new HostCallAdmission();
		expect(submitMany(admission, 264)).toEqual({ active: 8, waiting: 256, refused: [] });
		expect(admission.active).toBe(8);
		expect(admission.waiting).toBe(256);
	});

	it("265 -> exactly the 265th is refused with a correlated host_call_refused frame", () => {
		const admission = new HostCallAdmission();
		expect(submitMany(admission, 265).refused).toEqual(["call-265"]);
		const decision = new HostCallAdmission().submit("x");
		expect(decision.state).toBe("active");
		const full = new HostCallAdmission();
		submitMany(full, 264);
		const refused = full.submit("call-265");
		if (refused.state !== "refused") throw new Error("expected a refusal");
		expect(refused.frame).toEqual({ type: "host_call_refused", callId: "call-265", code: "host_call_capacity" });
		expect(isToolChildMessage(refused.frame)).toBe(true);
		expect(new FrameDecoder().push(encodeFrame(refused.frame))).toEqual([refused.frame]);
	});

	it("promotes waiting calls in FIFO order", () => {
		const admission = new HostCallAdmission();
		submitMany(admission, 264);
		const promoted: (string | undefined)[] = [];
		for (let index = 1; index <= 264; index += 1) promoted.push(admission.settle(callId(index)));
		expect(promoted.slice(0, 256)).toEqual(Array.from({ length: 256 }, (_, offset) => callId(offset + 9)));
		expect(promoted.slice(256)).toEqual(Array(8).fill(undefined));
		expect(admission.active + admission.waiting).toBe(0);
	});

	it("child and server share the capacity: the child never forwards a call the server would refuse", () => {
		const child = new HostCallAdmission();
		const server = new HostCallAdmission();
		const refusedByServer: string[] = [];
		for (let index = 1; index <= 300; index += 1) {
			if (child.submit(callId(index)).state === "refused") continue;
			const decision = server.submit(callId(index));
			if (decision.state === "refused") refusedByServer.push(decision.frame.callId);
		}
		expect(refusedByServer).toEqual([]);
		expect(server.active + server.waiting).toBe(hostCallCapacity());
	});

	it("refuses a duplicate call id", () => {
		const admission = new HostCallAdmission();
		admission.submit("same");
		const duplicate = admission.submit("same");
		expect(duplicate.state === "refused" && duplicate.frame.code).toBe("host_call_duplicate");
	});
});

describe("job admission", () => {
	it("refuses the 33rd ordinary job while a nested job is still admitted", () => {
		const jobs = new JobAdmission();
		for (let index = 1; index <= 32; index += 1) expect(jobs.admit(`job-${index}`)).toEqual({ admitted: true });
		expect(jobs.admit("job-33")).toEqual({
			admitted: false,
			frame: { type: "job_refused", jobId: "job-33", code: "tool_child_jobs_full" },
		});
		expect(jobs.admit("nested-1", "job-1")).toEqual({ admitted: true });
		expect(jobs.admit("nested-2", "missing")).toEqual({
			admitted: false,
			frame: { type: "job_refused", jobId: "nested-2", code: "tool_child_parent_unknown" },
		});
		jobs.finish("job-2");
		expect(jobs.admit("job-33")).toEqual({ admitted: true });
	});

	it("bounds nested jobs by the host-call capacity, not by a second constant", () => {
		const jobs = new JobAdmission();
		jobs.admit("parent");
		for (let index = 1; index <= hostCallCapacity(); index += 1) {
			expect(jobs.admit(`nested-${index}`, "parent")).toEqual({ admitted: true });
		}
		const over = jobs.admit("nested-over", "parent");
		expect(over.admitted === false && over.frame.code).toBe("tool_child_nested_full");
	});
});

describe("wake flow control", () => {
	it("the 65th pending wake waits for wake_ack and is never dropped", async () => {
		const wakes = new WakeAdmission();
		for (let index = 1; index <= 64; index += 1) await wakes.send(`w-${index}`, 10);
		const sixtyFifth = tracked(wakes.send("w-65", 10));
		const sixtySixth = tracked(wakes.send("w-66", 10));
		await turn();
		expect(sixtyFifth.settled).toBe(false);
		expect(wakes.blocked).toBe(2);
		expect(wakes.pending).toBe(64);
		wakes.ack("w-1");
		await turn();
		expect(sixtyFifth.settled).toBe(true);
		expect(sixtySixth.settled).toBe(false);
		wakes.ack("w-2");
		await turn();
		expect(sixtySixth.settled).toBe(true);
		expect(wakes.pending).toBe(64);
		expect(wakes.blocked).toBe(0);
	});

	it("bounds pending wakes by summed bytes and refuses one larger than the whole budget", async () => {
		const wakes = new WakeAdmission();
		const part = 600 * 1024;
		await wakes.send("a", part);
		const second = tracked(wakes.send("b", part));
		await turn();
		expect(second.settled).toBe(false);
		wakes.ack("a");
		await turn();
		expect(second.settled).toBe(true);
		await expect(wakes.send("huge", TOOL_CHILD_LIMITS.wakePendingBytes + 1)).rejects.toBeInstanceOf(
			WakeAdmissionError,
		);
	});
});

describe("trace budget", () => {
	it("drops and counts the 1,025th trace frame in one second, then admits again in the next", () => {
		const budget = new TraceBudget();
		const frame = { type: "trace", atMs: 0, event: "tick" } as const;
		const admitted = Array.from({ length: 1025 }, () => budget.admit(frame, 5_000));
		expect(admitted.filter(Boolean)).toHaveLength(1024);
		expect(admitted.at(-1)).toBe(false);
		expect(budget.dropped).toBe(1);
		expect(budget.admit(frame, 6_000)).toBe(true);
		expect(budget.dropped).toBe(1);
	});

	it("trace is the only lossy class; results, proofs and ticks are never lossy", () => {
		expect([...LOSSY_FRAME_TYPES]).toEqual(["trace"]);
		expect(isLossy({ type: "trace", atMs: 1, event: "e" })).toBe(true);
		expect(isLossy({ type: "launch_proof", launchId: "l", ackTick: 1, invokeTick: 2 })).toBe(false);
		expect(isLossy({ type: "result", jobId: "j", value: 1 })).toBe(false);
		expect(isLossy({ type: "slot_state", launchId: "l", ackTick: 1, invokeTick: 2, invocations: 1 })).toBe(false);
		expect(isToolChildMessage({ type: "trace", atMs: 1, event: "e", detail: { invokeTick: 2 } })).toBe(false);
		expect(isToolChildMessage({ type: "trace", atMs: 1, event: "e", result: 1 })).toBe(false);
	});
});
