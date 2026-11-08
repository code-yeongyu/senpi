import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PreparableRuntimeFactory } from "../../../src/modes/rpc/host-warm.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";

let scratch: string;

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "senpi-6199-open-"));
});

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true });
});

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

// senpi#6199: an extension load now yields the host loop between modules, so an open_session can arrive while a warm
// (the boot load of senpi#6147 included) is still loading. Its factories must not run beside that load: the boot load
// is the host's first extension load, and an extension claiming a private channel there must not be claimed twice.
describe("an in-process open and a warm in flight (senpi#6199)", () => {
	it("builds the session runtime only after every warm in flight has settled", async () => {
		// Given: a warm whose load spans many turns of the loop, as a yielding extension import does.
		const events: string[] = [];
		const createRuntime = Object.assign(
			async () => {
				events.push("open builds its runtime");
				throw new Error("this test stops the open once its runtime is requested");
			},
			{
				prepare: async () => {
					events.push("warm starts loading");
					for (let turn = 0; turn < 50; turn++) await nextTurn();
					events.push("warm finished loading");
				},
			},
		) satisfies PreparableRuntimeFactory;
		const registry = new RpcSessionRegistry({ agentDir: scratch, createRuntime });
		if (registry.warm === undefined) throw new Error("the registry should warm through prepare");

		// When: an open arrives while that warm is loading.
		const warming = registry.warm({ cwd: scratch });
		await nextTurn();
		const opening = registry.openSession({ cwd: scratch });

		// Then: the open waited for the warm before it built anything.
		await expect(opening).rejects.toThrow("this test stops the open");
		expect(await warming).toBe("warmed");
		expect(events).toEqual(["warm starts loading", "warm finished loading", "open builds its runtime"]);
	});

	it("opens at once when no warm is in flight", async () => {
		// Given
		const events: string[] = [];
		const createRuntime = Object.assign(
			async () => {
				events.push("open builds its runtime");
				throw new Error("this test stops the open once its runtime is requested");
			},
			{ prepare: async () => {} },
		) satisfies PreparableRuntimeFactory;
		const registry = new RpcSessionRegistry({ agentDir: scratch, createRuntime });
		await registry.warm?.({ cwd: scratch });

		// When / Then
		await expect(registry.openSession({ cwd: scratch })).rejects.toThrow("this test stops the open");
		expect(events).toEqual(["open builds its runtime"]);
	});
});
