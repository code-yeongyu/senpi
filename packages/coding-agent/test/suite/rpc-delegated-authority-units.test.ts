/**
 * omo-relay-daemon#307, the authority word itself: packing, monotone stores and the epoch bound (W5), incarnation
 * allocation that never wraps (L4), one snapshot per command as its admission (W3), and a host store seen through the
 * same shared memory by a worker thread that was already blocked before its role check (W1).
 */
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { CommandAuthority } from "../../src/modes/rpc/command-authority.ts";
import {
	createAuthority,
	decodeWord,
	INCARNATION_MAX,
	incarnationOf,
	nextIncarnation,
	readAuthority,
	storeNarrowed,
	storeRetired,
} from "../../src/modes/rpc/connection-authority.ts";
import type { DelegationDescriptor } from "../../src/modes/rpc/delegation-record.ts";
import { awaitWord } from "./rpc-delegated-host-support.ts";

const IU = "interactive_user";
const TP = "task_parent";
const PRINCIPAL = { deviceId: "x307-device" };

describe("W5: the authority word", () => {
	it("moves the epoch only on a real transition, stays monotone, and restarts at 1 per incarnation", () => {
		const buffer = createAuthority(1, 3);
		const epochs = [readAuthority(buffer).epoch];
		const stores = [
			() => storeNarrowed(buffer, [TP]),
			() => storeNarrowed(buffer, []),
			() => storeNarrowed(buffer, []),
			() => storeRetired(buffer),
			() => storeRetired(buffer),
		];
		const changed = stores.map((store) => {
			const moved = store();
			epochs.push(readAuthority(buffer).epoch);
			return moved;
		});
		expect(changed).toEqual([true, true, false, true, false]);
		expect(epochs).toEqual([1, 2, 3, 3, 4, 4]);
		expect(readAuthority(buffer)).toEqual({ epoch: 4, retired: true, mask: 0, roles: [] });
		expect(Atomics.load(new Int32Array(buffer), 0)).toBe(36);
		expect(decodeWord(36).epoch).toBe(4);
		expect(storeNarrowed(buffer, [IU, TP])).toBe(false);
		expect(readAuthority(createAuthority(2, 0)).epoch).toBe(1);
	});
});

describe("L4: incarnation allocation and exhaustion", () => {
	it("checks the successor before any stamp and never wraps", () => {
		expect(nextIncarnation(0x7ffffffe)).toBe(0x7fffffff);
		expect(nextIncarnation(INCARNATION_MAX)).toBeUndefined();
		expect(incarnationOf(createAuthority(INCARNATION_MAX, 3))).toBe(INCARNATION_MAX);
	});
});

describe("W3: one snapshot per command is its admission", () => {
	it("keeps a command admitted before the store, and refuses the next command", () => {
		const authority = createAuthority(1, 3);
		const descriptor: DelegationDescriptor = { principal: PRINCIPAL, mode: "host", incarnation: 1, authority };
		const admitted = new CommandAuthority("c", descriptor, 7);
		expect(admitted.has(IU, [IU])).toBe(true);
		storeRetired(authority);
		expect(admitted.has(IU, [IU])).toBe(true);
		expect(admitted.receipt()).toEqual({ exec: 7, incarnation: 1, epoch: 1, roles: [IU] });
		const later = new CommandAuthority("c", descriptor, 8);
		expect(later.has(IU, [IU])).toBe(false);
		expect(later.receipt()).toEqual({ exec: 8, incarnation: 1, epoch: 2, roles: [] });
		expect(new CommandAuthority("c", descriptor, 9).receipt()).toEqual({
			exec: 9,
			incarnation: 1,
			epoch: 2,
			roles: null,
		});
	});
});

const PROBE = `
import { workerData, parentPort } from "node:worker_threads";
const { readAuthority } = await import(workerData.module);
const gate = new Int32Array(workerData.gate);
for (let step = 1; step <= 2; step++) {
	Atomics.wait(gate, 0, step - 1);
	parentPort.postMessage(readAuthority(workerData.authority));
}
`;

describe("W1: a host store is visible to a worker that was already blocked before its role check", () => {
	it("reads the narrowed, then the retired word through the same shared buffer", async () => {
		const authority = createAuthority(1, 3);
		const gate = new SharedArrayBuffer(4);
		const module = new URL("../../src/modes/rpc/connection-authority.ts", import.meta.url).href;
		const worker = new Worker(PROBE, { eval: true, workerData: { authority, gate, module } });
		const seen: unknown[] = [];
		const reads = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		worker.on("message", (state) => {
			seen.push(state);
			reads[seen.length - 1]?.resolve();
		});
		worker.once("error", (error) => {
			for (const read of reads) read.reject(error);
		});
		const view = new Int32Array(authority);
		const gateView = new Int32Array(gate);
		storeNarrowed(authority, [TP]);
		await awaitWord(view, 0, (word) => decodeWord(word).epoch === 2);
		Atomics.store(gateView, 0, 1);
		Atomics.notify(gateView, 0);
		await reads[0]?.promise;
		storeRetired(authority);
		Atomics.store(gateView, 0, 2);
		Atomics.notify(gateView, 0);
		await reads[1]?.promise;
		await worker.terminate();
		expect(seen).toEqual([
			{ epoch: 2, retired: false, mask: 2, roles: [TP] },
			{ epoch: 3, retired: true, mask: 2, roles: [TP] },
		]);
		expect(fileURLToPath(module)).toMatch(/connection-authority\.ts$/);
	});
});
