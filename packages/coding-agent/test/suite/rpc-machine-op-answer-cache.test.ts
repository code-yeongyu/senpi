/**
 * senpi#6752: the engine's `machine_op` answer cache is bounded by count (MACHINE_OP_CACHE_MAX_ENTRIES) and by age
 * (MACHINE_OP_CACHE_MAX_AGE_MS): an op_id past either bound runs again, one within both never does.
 */
import { describe, expect, it } from "vitest";
import {
	MACHINE_OP_CACHE_MAX_AGE_MS,
	MACHINE_OP_CACHE_MAX_ENTRIES,
	MachineOpAnswerCache,
} from "../../src/modes/rpc/machine-op/answer-cache.ts";

function counted(): { readonly runs: () => number; readonly run: () => Promise<string> } {
	let runs = 0;
	return { runs: () => runs, run: async () => `run ${++runs}` };
}

describe("senpi#6752: machine_op answer cache bounds", () => {
	it("forgets the oldest settled answer once it holds more than MACHINE_OP_CACHE_MAX_ENTRIES", async () => {
		const cache = new MachineOpAnswerCache<string>();
		const oldest = counted();
		await cache.answer("op-0", "device-a", oldest.run);
		for (let index = 1; index < MACHINE_OP_CACHE_MAX_ENTRIES; index += 1)
			await cache.answer(`op-${index}`, "device-a", oldest.run);
		expect(cache.size).toBe(MACHINE_OP_CACHE_MAX_ENTRIES);
		expect(cache.settled("op-0")).toBe("run 1");
		await cache.answer(`op-${MACHINE_OP_CACHE_MAX_ENTRIES}`, "device-a", oldest.run);
		expect(cache.size).toBe(MACHINE_OP_CACHE_MAX_ENTRIES);
		expect(cache.settled("op-0")).toBeUndefined();
		expect(cache.settled("op-1")).toBe("run 2");
	});

	it("forgets an answer older than MACHINE_OP_CACHE_MAX_AGE_MS and runs that op_id again", async () => {
		let now = 1_000;
		const cache = new MachineOpAnswerCache<string>({ now: () => now });
		const op = counted();
		expect(await cache.answer("op", "device-a", op.run)).toBe("run 1");
		now += MACHINE_OP_CACHE_MAX_AGE_MS;
		expect(await cache.answer("op", "device-a", op.run)).toBe("run 1");
		now += 1;
		expect(cache.settled("op")).toBeUndefined();
		expect(await cache.answer("op", "device-a", op.run)).toBe("run 2");
	});

	it("joins a repeat to the run in flight and never reports an unsettled answer", async () => {
		const cache = new MachineOpAnswerCache<string>();
		const gate = Promise.withResolvers<string>();
		let runs = 0;
		const run = () => {
			runs += 1;
			return gate.promise;
		};
		const first = cache.answer("op", "device-a", run);
		const second = cache.answer("op", "device-a", run);
		expect(cache.settled("op")).toBeUndefined();
		gate.resolve("done");
		expect(await Promise.all([first, second])).toEqual(["done", "done"]);
		expect(runs).toBe(1);
		expect(cache.settled("op")).toBe("done");
	});
});
