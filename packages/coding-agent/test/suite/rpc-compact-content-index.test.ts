import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CompactContentIndex } from "../../src/modes/rpc/compact-content-index.ts";
import { CompactContentStore, type LeafId } from "../../src/modes/rpc/compact-content-store.ts";
import { CompactSessionState, type CompactSessionStateOptions } from "../../src/modes/rpc/compact-session-state.ts";
import { controlledIo, spoolRoot, startIdentity } from "./compact-storage-support.ts";

// senpi#4272 (S03a-2): the spillable settled-row index under concurrent transitions. Every
// asynchronous step is driven by an explicit I/O hold or by awaiting idle, never by elapsed time.

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(options: Partial<CompactSessionStateOptions> = {}) {
	const root = await spoolRoot();
	const control = controlledIo();
	const state = new CompactSessionState({ dir: root.dir, io: control.io, compactAboveRows: 3, ...options });
	cleanups.push(async () => {
		await state.retire();
		await root.cleanup();
	});
	return { state, control, dir: root.dir };
}

function start(messageId: string, seed: string) {
	return {
		type: "block_start",
		...startIdentity(),
		messageId,
		contentIndex: 0,
		kind: "text",
		seed,
		coveredCodeUnits: 0,
	} as const;
}

function settle(state: CompactSessionState, messageId: string, seed: string, persistence = "pending" as const) {
	state.accept(start(messageId, seed));
	state.accept({ type: "message_status", messageId, persistence });
}

async function texts(state: CompactSessionState) {
	const cut = state.freeze();
	try {
		const view = await state.read(cut);
		return Object.fromEntries(view.messages.map((m) => [m.messageId, m.blocks.map((b) => b.text).join("")]));
	} finally {
		state.release(cut);
	}
}

async function spoolFiles(dir: string, prefix: "leaf-" | "page-"): Promise<string[]> {
	return (await readdir(dir)).filter((name) => name.startsWith(prefix));
}

/** Settles m1 and m2 with spilled leaves, then holds the page write of the compaction m3 starts. */
async function compactionInFlight() {
	const setupResult = await setup({ spillAboveBytes: 0, spillTargetBytes: 0 });
	const { state, control } = setupResult;
	settle(state, "m1", "a1");
	settle(state, "m2", "b2");
	await state.idle();
	const pageWrite = control.hold("write", (path) => /[/\\]page-/.test(path));
	settle(state, "m3", "");
	expect(await pageWrite.entered).toContain("page-");
	return { ...setupResult, pageWrite };
}

describe("compact content index: transitions racing a compaction", () => {
	it("skips a row removed between the snapshot and the publish, and the next compaction still runs", async () => {
		const { state, dir, pageWrite } = await compactionInFlight();
		await state.applyCold({ type: "message_remove", messageId: "m2" });
		pageWrite.release();
		await state.idle();

		expect(state.storageStatus()).toMatchObject({ failures: [], overrideSlots: 0, deletionMasks: 0, baseRows: 2 });
		expect(await texts(state)).toEqual({ m1: "a1", m3: "" });

		for (const id of ["m4", "m5", "m6"]) settle(state, id, "");
		await state.idle();
		const status = state.storageStatus();
		expect(status).toMatchObject({ failures: [], overrideSlots: 0, baseRows: 5, reclaimDebtBytes: 0 });
		expect(await texts(state)).toEqual({ m1: "a1", m3: "", m4: "", m5: "", m6: "" });
		expect(await spoolFiles(dir, "leaf-")).toHaveLength(0);
		expect(status.structuredBytes.resident).toBe(0);
		expect(await spoolFiles(dir, "page-")).toHaveLength(status.basePages);
	});

	it("keeps a row re-created with new leaves during compaction and releases the replaced leaves", async () => {
		const { state, dir, pageWrite } = await compactionInFlight();
		await state.applyCold({ type: "message_remove", messageId: "m2" });
		settle(state, "m2", "new2");
		pageWrite.release();
		await state.idle();

		expect(state.storageStatus()).toMatchObject({ failures: [], overrideSlots: 1 });
		expect(await texts(state)).toEqual({ m1: "a1", m2: "new2", m3: "" });
		expect(state.storageStatus().structuredBytes.resident).toBe(0);

		for (const id of ["m4", "m5"]) settle(state, id, "");
		await state.idle();
		expect(state.storageStatus()).toMatchObject({ failures: [], overrideSlots: 0, baseRows: 5, reclaimDebtBytes: 0 });
		expect(await texts(state)).toEqual({ m1: "a1", m2: "new2", m3: "", m4: "", m5: "" });
		expect(await spoolFiles(dir, "leaf-")).toHaveLength(0);
	});

	it("keeps the previous index after a failed page write, and the next compaction publishes", async () => {
		const { state, control } = await setup();
		const pageWrite = control.hold("write", (path) => /[/\\]page-/.test(path));
		for (const id of ["m1", "m2", "m3"]) settle(state, id, "");
		await pageWrite.entered;
		pageWrite.fail(new Error("disk full"));
		await state.idle();

		const failed = state.storageStatus();
		expect(failed).toMatchObject({ basePages: 0, overrideSlots: 3, spillHalted: false, reclaimDebtBytes: 0 });
		expect(failed.failures).toMatchObject([{ operation: "page_write" }]);
		expect(Object.keys(await texts(state))).toEqual(["m1", "m2", "m3"]);

		settle(state, "m4", "");
		await state.idle();
		// The bounded structural flush makes m4 eligible alongside the three retained rows.
		expect(state.storageStatus()).toMatchObject({ basePages: 1, baseRows: 4, overrideSlots: 0 });
		expect(Object.keys(await texts(state))).toEqual(["m1", "m2", "m3", "m4"]);
	});

	it("publishes nothing once retirement started", async () => {
		const { state, control, dir } = await setup();
		const pageWrite = control.hold("write", (path) => /[/\\]page-/.test(path));
		for (const id of ["m1", "m2", "m3"]) settle(state, id, "");
		await pageWrite.entered;
		const retired = state.retire();
		pageWrite.release();
		await retired;

		expect(state.storageStatus()).toMatchObject({ failures: [], basePages: 0, overrideSlots: 3 });
		await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
	});
});

describe("compact content index: acceptance cost and page shape", () => {
	it("does not rescan every override per acceptance while leaves are still resident", async () => {
		const root = await spoolRoot();
		cleanups.push(root.cleanup);
		const store = new CompactContentStore({ dir: root.dir });
		let calls = 0;
		const index = new CompactContentIndex<{ readonly leaves: readonly LeafId[]; readonly n: number }>(
			store,
			(row) => {
				calls++;
				return row.leaves;
			},
			3,
		);
		for (let i = 0; i < 50; i++) {
			const leaf = store.createLeaf("x");
			index.set(`m${i}`, { leaves: [leaf], n: 0 });
			store.adjust(leaf, -1, 0);
		}
		await store.idle();
		calls = 0;
		for (let n = 1; n <= 100; n++) {
			index.patch("m0", { n });
			await store.idle();
		}
		expect(calls).toBeLessThanOrEqual(100 * 5);
	});

	it("measures page size in UTF-8 bytes", async () => {
		const { state, dir } = await setup();
		for (const i of [1, 2, 3]) settle(state, `${"가".repeat(12_000)}${i}`, "");
		await state.idle();
		const pages = await spoolFiles(dir, "page-");
		expect(pages.length).toBe(state.storageStatus().basePages);
		for (const page of pages) expect((await stat(join(dir, page))).size).toBeLessThanOrEqual(64 * 1024);
	});

	it("merges small pages instead of adding one per compaction", async () => {
		const { state } = await setup();
		for (const id of ["m1", "m2", "m3"]) settle(state, id, "");
		await state.idle();
		for (const id of ["m4", "m5", "m6"]) settle(state, id, "");
		await state.idle();
		expect(state.storageStatus()).toMatchObject({ failures: [], basePages: 1, baseRows: 6, overrideSlots: 0 });
	});
});
