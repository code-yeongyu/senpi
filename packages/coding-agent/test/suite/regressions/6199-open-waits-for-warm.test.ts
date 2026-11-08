import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

	it("does not wait for a warm of another working directory", async () => {
		// Given: a warm of an unrelated cwd whose load spans many turns of the loop.
		const events: string[] = [];
		const other = join(scratch, "other");
		await mkdir(other);
		const createRuntime = Object.assign(
			async () => {
				events.push("open builds its runtime");
				throw new Error("this test stops the open once its runtime is requested");
			},
			{
				prepare: async () => {
					for (let turn = 0; turn < 50; turn++) await nextTurn();
					events.push("other warm finished loading");
				},
			},
		) satisfies PreparableRuntimeFactory;
		const registry = new RpcSessionRegistry({ agentDir: scratch, createRuntime, closeGraceMs: 60_000 });
		if (registry.warm === undefined) throw new Error("the registry should warm through prepare");
		const warming = registry.warm({ cwd: other });
		await nextTurn();

		// When
		await expect(registry.openSession({ cwd: scratch })).rejects.toThrow("this test stops the open");
		await warming;

		// Then: the open built its runtime while the other cwd's warm was still loading.
		expect(events).toEqual(["open builds its runtime", "other warm finished loading"]);
	});

	it("does not wait for a warm that starts while it is already waiting", async () => {
		// Given: an open waiting on a short warm of its cwd.
		const events: string[] = [];
		const createRuntime = Object.assign(
			async () => {
				events.push("open builds its runtime");
				throw new Error("this test stops the open once its runtime is requested");
			},
			{
				prepare: async (options: { launchProfile: { sessionKind?: string } }) => {
					const turns = options.launchProfile.sessionKind === "worker" ? 500 : 10;
					for (let turn = 0; turn < turns; turn++) await nextTurn();
					events.push(`${options.launchProfile.sessionKind ?? "default"} warm finished loading`);
				},
			},
		) satisfies PreparableRuntimeFactory;
		const registry = new RpcSessionRegistry({ agentDir: scratch, createRuntime, closeGraceMs: 60_000 });
		if (registry.warm === undefined) throw new Error("the registry should warm through prepare");
		const first = registry.warm({ cwd: scratch });
		await nextTurn();
		const opening = registry.openSession({ cwd: scratch });

		// When: a second, much longer warm of that cwd starts after the open began waiting.
		const later = registry.warm({ cwd: scratch, sessionKind: "worker" });

		// Then: the open waited only for the warm in flight when it arrived.
		await expect(opening).rejects.toThrow("this test stops the open");
		await Promise.all([first, later]);
		expect(events).toEqual([
			"default warm finished loading",
			"open builds its runtime",
			"worker warm finished loading",
		]);
	});

	it("opens after its bound when a warm of its cwd never settles", async () => {
		// Given: a warm whose extension factory never settles, and a short open bound.
		const events: string[] = [];
		const createRuntime = Object.assign(
			async () => {
				events.push("open builds its runtime");
				throw new Error("this test stops the open once its runtime is requested");
			},
			{ prepare: () => new Promise<void>(() => {}) },
		) satisfies PreparableRuntimeFactory;
		const registry = new RpcSessionRegistry({ agentDir: scratch, createRuntime, closeGraceMs: 10_000 });
		if (registry.warm === undefined) throw new Error("the registry should warm through prepare");
		void registry.warm({ cwd: scratch });
		await nextTurn();
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

		try {
			// When: the open's bound expires.
			const opened = expect(registry.openSession({ cwd: scratch })).rejects.toThrow("this test stops the open");
			await vi.advanceTimersByTimeAsync(10_000);

			// Then: the open proceeds and says why.
			await opened;
			expect(events).toEqual(["open builds its runtime"]);
			expect(stderr).toHaveBeenCalledWith(expect.stringContaining("warm_wait_deadline"));
		} finally {
			vi.useRealTimers();
			stderr.mockRestore();
		}
	}, 2_000);

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
