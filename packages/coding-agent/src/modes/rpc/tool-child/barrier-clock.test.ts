// senpi#3566 todo 4: the barrier clock is the causal proof of the execution barrier, shared across threads.
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { BarrierClock, proofIsOrdered } from "./barrier-clock.ts";

const TICKER = `
const { workerData, parentPort } = require("node:worker_threads");
const cells = new Int32Array(workerData.buffer);
const ticks = [];
for (let i = 0; i < workerData.count; i++) ticks.push(Atomics.add(cells, 0, 1) + 1);
parentPort.postMessage(ticks);
`;

const ACK_WAITER = `
const { workerData, parentPort } = require("node:worker_threads");
const cells = new Int32Array(workerData.buffer);
const ackIndex = 1 + workerData.slot * 4;
parentPort.postMessage({ waiting: true });
while (Atomics.load(cells, ackIndex) === 0) Atomics.wait(cells, ackIndex, 0);
const ackTick = Atomics.load(cells, ackIndex);
const invokeTick = Atomics.add(cells, 0, 1) + 1;
Atomics.store(cells, ackIndex + 1, invokeTick);
Atomics.add(cells, ackIndex + 2, 1);
parentPort.postMessage({ ackTick, invokeTick });
`;

describe("BarrierClock", () => {
	it("hands out strictly increasing, unique ticks to a main thread and a worker under contention", async () => {
		const clock = BarrierClock.create(1);
		const worker = new Worker(TICKER, { eval: true, workerData: { buffer: clock.buffer, count: 5_000 } });
		const fromWorker = once(worker, "message");
		const fromMain: number[] = [];
		for (let i = 0; i < 5_000; i++) fromMain.push(clock.tick());
		const [workerTicks] = (await fromWorker) as [number[]];
		await worker.terminate();
		for (const ticks of [fromMain, workerTicks])
			for (let i = 1; i < ticks.length; i++) expect(ticks[i]).toBeGreaterThan(ticks[i - 1] ?? 0);
		const all = new Set([...fromMain, ...workerTicks]);
		expect(all.size).toBe(10_000);
		expect(Math.min(...all)).toBe(1);
		expect(Math.max(...all)).toBe(10_000);
	});

	it("wakes a worker blocked on the ack with the tick the protocol loop recorded", async () => {
		const clock = BarrierClock.create(4);
		const slot = clock.claimSlot();
		if (slot === undefined) throw new Error("no slot");
		const worker = new Worker(ACK_WAITER, { eval: true, workerData: { buffer: clock.buffer, slot } });
		const [ready] = (await once(worker, "message")) as [{ waiting: boolean }];
		expect(ready.waiting).toBe(true);
		expect(clock.read(slot)).toEqual({ ackTick: null, invokeTick: null, invocations: 0 });
		const proofPromise = once(worker, "message");
		const ackTick = clock.recordAck(slot);
		const [proof] = (await proofPromise) as [{ ackTick: number; invokeTick: number }];
		await worker.terminate();
		expect(proof.ackTick).toBe(ackTick);
		expect(proofIsOrdered(proof)).toBe(true);
		expect(clock.read(slot)).toEqual({ ackTick, invokeTick: proof.invokeTick, invocations: 1 });
	});

	it("reports an invocation without an ack as an unordered proof with a null ackTick", () => {
		const clock = BarrierClock.create(2);
		const slot = clock.claimSlot() ?? -1;
		const proof = clock.recordInvoke(slot);
		expect(proof.ackTick).toBeNull();
		expect(proofIsOrdered(proof)).toBe(false);
		expect(clock.read(slot).invocations).toBe(1);
		expect(proofIsOrdered({ ackTick: 7, invokeTick: 7 })).toBe(false);
	});

	it("claims and recycles slots, resetting a reused slot, and refuses when all are in flight", () => {
		const clock = BarrierClock.create(2);
		const first = clock.claimSlot() ?? -1;
		const second = clock.claimSlot() ?? -1;
		expect(new Set([first, second])).toEqual(new Set([0, 1]));
		expect(clock.claimSlot()).toBeUndefined();
		clock.recordAck(first);
		clock.recordInvoke(first);
		clock.releaseSlot(first);
		expect(clock.claimSlot()).toBe(first);
		expect(clock.read(first)).toEqual({ ackTick: null, invokeTick: null, invocations: 0 });
		expect(() => clock.read(2)).toThrow(/no barrier slot 2/);
	});

	it("times out a bounded ack wait instead of blocking forever", () => {
		const clock = BarrierClock.create(1);
		const slot = clock.claimSlot() ?? -1;
		expect(clock.waitForAck(slot, 1)).toBe("timed-out");
		clock.recordAck(slot);
		expect(clock.waitForAck(slot, 1)).toBe("acked");
	});
});
