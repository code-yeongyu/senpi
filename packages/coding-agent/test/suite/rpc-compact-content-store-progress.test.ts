import { open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CompactContentStoreOptions,
	COMPACT_LEAF_CODE_UNITS as LEAF,
} from "../../src/modes/rpc/compact-content-store.ts";
import { CompactSessionState } from "../../src/modes/rpc/compact-session-state.ts";
import type { CompactStorageIo } from "../../src/modes/rpc/compact-storage-io.ts";
import { controlledIo, spoolRoot } from "./compact-storage-support.ts";

// senpi#4272 (review L4-L8): storage failures and churn never stall spilling silently, leak spool
// files, or mint unbounded leaves. Retry backoff is driven by fake timers, every other step by I/O holds.

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

const eager = { spillAboveBytes: 0, spillTargetBytes: 0 };

async function setup(options: Partial<CompactContentStoreOptions> = {}) {
	const root = await spoolRoot();
	const control = controlledIo();
	const state = new CompactSessionState({ dir: root.dir, io: control.io, ...eager, ...options });
	cleanups.push(async () => {
		await state.retire().catch(() => undefined);
		await root.cleanup();
	});
	return { state, control, dir: root.dir };
}

const leafFiles = async (dir: string) => (await readdir(dir)).filter((name) => name.startsWith("leaf-"));

function settle(state: CompactSessionState, messageId: string, seed: string): void {
	state.accept({ type: "block_start", messageId, contentIndex: 0, kind: "text", seed, coveredCodeUnits: 0 });
	state.accept({ type: "message_status", messageId, persistence: "pending" });
}

async function texts(state: CompactSessionState, cut = state.freeze()): Promise<string[]> {
	const view = await state.read(cut);
	state.release(cut);
	return view.messages.map((m) => m.blocks[0]?.text ?? "");
}

const injected = (code: string) => Object.assign(new Error(`${code}: injected`), { code });

describe("compact content store: failed writes and unlinks (L4, L5)", () => {
	it("unlinks the partial file of a failed spill write", async () => {
		const real = controlledIo().io;
		const io: CompactStorageIo = {
			...real,
			async writeFile(path, data) {
				const handle = await open(path, "wx", 0o600);
				await handle.write(data.subarray(0, 100));
				await handle.close();
				throw injected("EIO");
			},
		};
		const { state, dir } = await setup({ io });
		settle(state, "m1", "p".repeat(LEAF));
		await state.idle();
		expect(state.storageStatus()).toMatchObject({
			spillHalted: true,
			reclaimDebtBytes: 0,
			residentPayloadBytes: 65_536,
		});
		expect(await leafFiles(dir)).toEqual([]);
		expect(await texts(state)).toEqual(["p".repeat(LEAF)]);
	});

	it("retries a failed unlink with backoff until the debt is released", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { state, control, dir } = await setup();
		settle(state, "m1", "u".repeat(LEAF));
		await state.idle();
		const first = control.hold("unlink");
		state.accept({ type: "message_remove", messageId: "m1" });
		await first.entered;
		first.fail(injected("EBUSY"));
		await state.idle();
		expect(state.storageStatus()).toMatchObject({ reclaimDebtBytes: 65_536, failures: [{ operation: "reclaim" }] });

		await vi.advanceTimersByTimeAsync(60_000);
		await state.idle();
		expect(state.storageStatus().reclaimDebtBytes).toBe(0);
		expect(await leafFiles(dir)).toEqual([]);
	});

	it("reports spilling as halted while unreclaimed debt exceeds the work allowance", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let failUnlink = false;
		const real = controlledIo().io;
		const io: CompactStorageIo = {
			...real,
			unlink: (path) => (failUnlink ? Promise.reject(injected("EBUSY")) : real.unlink(path)),
		};
		const { state } = await setup({ io });
		settle(state, "m1", "d".repeat(17 * LEAF));
		await state.idle();
		failUnlink = true;
		state.accept({ type: "message_remove", messageId: "m1" });
		await state.idle();
		expect(state.storageStatus()).toMatchObject({ reclaimDebtBytes: 17 * 65_536, spillHalted: true });
	});

	it("labels a spill failure it cannot describe with its own operation and file, and reports the halt", async () => {
		const cause = injected("EIO");
		Object.defineProperty(cause, "message", {
			get() {
				throw new Error("describe crashed");
			},
		});
		const io: CompactStorageIo = { ...controlledIo().io, writeFile: () => Promise.reject(cause) };
		const { state, dir } = await setup({ io });
		settle(state, "m1", "j".repeat(LEAF));
		await state.idle();
		expect(state.storageStatus()).toMatchObject({
			spillHalted: true,
			failures: [
				{
					operation: "spill_write",
					path: join(dir, "leaf-1.bin"),
					cause: expect.any(String),
					retainedInMemoryBytes: 65_536,
				},
			],
		});
	});
});

describe("compact content store: reads, churn and retirement (L6, L7, L8)", () => {
	it("keeps spilling after a committed leaf read fails", async () => {
		const { state, dir } = await setup();
		settle(state, "m1", "r".repeat(LEAF));
		await state.idle();
		const [file] = await leafFiles(dir);
		await unlink(join(dir, file));
		await expect(texts(state)).rejects.toMatchObject({ name: "CompactStorageReadError", operation: "leaf_read" });
		expect(state.storageStatus().spillHalted).toBe(false);

		settle(state, "m2", "s".repeat(LEAF));
		await state.idle();
		expect(state.storageStatus()).toMatchObject({ spillHalted: false, spilledLiveBytes: 131_072 });
	});

	it("does not mint a leaf per freeze of a tiny active tail, and old cuts keep their value", async () => {
		const { state } = await setup();
		state.accept({
			type: "block_start",
			messageId: "m1",
			contentIndex: 0,
			kind: "text",
			seed: "",
			coveredCodeUnits: 0,
		});
		let early = state.freeze();
		for (let i = 0; i < 200; i++) {
			state.accept({ type: "block_delta", messageId: "m1", contentIndex: 0, offset: i, text: "x" });
			if (i === 49) {
				state.release(early);
				early = state.freeze();
			}
			expect(await texts(state)).toEqual(["x".repeat(i + 1)]);
		}
		await state.idle();
		expect(state.storageStatus()).toMatchObject({
			residentPayloadBytes: 0,
			spillBytesWritten: 0,
			residentTailBytes: 400,
			frozenTailBytes: 100,
		});
		expect(await texts(state, early)).toEqual(["x".repeat(50)]);
		expect(state.storageStatus().frozenTailBytes).toBe(0);
	});

	it("spills the next leaf without rescanning every committed leaf", async () => {
		const { state } = await setup();
		for (let i = 0; i < 300; i++) settle(state, `m${i}`, "t");
		await state.idle();
		expect(state.storageStatus()).toMatchObject({ residentPayloadBytes: 0, spilledLiveBytes: 600 });

		const entries = Map.prototype.entries;
		let steps = 0;
		vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function (this: Map<unknown, unknown>) {
			const iterator = entries.call(this);
			if (this.size < 300) return iterator;
			const counting = {
				next: () => {
					steps++;
					return iterator.next();
				},
				[Symbol.iterator]: () => counting,
			};
			return counting as unknown as ReturnType<typeof entries>;
		});
		settle(state, "last", "t");
		await state.idle();
		vi.restoreAllMocks();
		expect(state.storageStatus().spilledLiveBytes).toBe(602);
		expect(steps).toBe(0);
	});

	it("drops unlinks queued after retirement without recording failures or debt", async () => {
		const { state } = await setup();
		settle(state, "m1", "z".repeat(LEAF));
		await state.idle();
		await state.retire();
		state.accept({ type: "message_remove", messageId: "m1" });
		await state.idle();
		expect(state.storageStatus()).toMatchObject({ failures: [], reclaimDebtBytes: 0, spilledLiveBytes: 0 });
	});
});
