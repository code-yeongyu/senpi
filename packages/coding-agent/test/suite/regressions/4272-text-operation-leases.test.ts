import { stat } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { COMPACT_LEAF_CODE_UNITS as LEAF, CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import { CompactSessionState } from "../../../src/modes/rpc/compact-session-state.ts";
import { controlledIo, spoolRoot, startIdentity } from "../compact-storage-support.ts";

// senpi#4272, RULING-26a: release/retire invalidates results, but not an in-flight I/O's storage.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

it("keeps a released cut's file until the held read unwinds and rejects the stale result", async () => {
	const root = await spoolRoot();
	cleanups.push(root.cleanup);
	const control = controlledIo();
	const entered = Promise.withResolvers<string>();
	const gate = Promise.withResolvers<void>();
	const state = new CompactSessionState({
		dir: root.dir,
		spillAboveBytes: 0,
		spillTargetBytes: 0,
		io: {
			...control.io,
			async readFile(path, range) {
				if (/[/\\]leaf-/.test(path)) {
					entered.resolve(path);
					await gate.promise;
				}
				return control.io.readFile(path, range);
			},
		},
	});
	state.accept({
		type: "block_start",
		...startIdentity(),
		messageId: "m",
		contentIndex: 0,
		kind: "text",
		seed: "a".repeat(LEAF * 2),
		coveredCodeUnits: 0,
	});
	await state.idle();
	const cut = state.freeze();
	const reading = state.read(cut).then(
		() => undefined,
		(error: unknown) => error,
	);
	const path = await entered.promise;
	state.accept({ type: "block_replace", messageId: "m", contentIndex: 0, text: "new" });
	state.release(cut);
	await state.idle();
	const heldSize = await stat(path).then(
		(file) => file.size,
		() => -1,
	);
	gate.resolve();
	expect(await reading).toMatchObject({ name: "CompactReadError", reason: "released" });
	expect(heldSize).toBe(LEAF * 2);
	await state.idle();
	await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
	state.accept({ type: "message_remove", messageId: "m" });
	await state.idle();
	expect(state.storageStatus()).toMatchObject({ pinnedOnlyBytes: 0, reclaimDebtBytes: 0, residentTextNodes: 0 });
	await state.retire();
});

it("joins direct leaf reads before retiring the spool and refuses their stale results", async () => {
	const root = await spoolRoot();
	cleanups.push(root.cleanup);
	const control = controlledIo();
	const entered = Promise.withResolvers<string>();
	const gate = Promise.withResolvers<void>();
	const store = new CompactContentStore({
		dir: root.dir,
		spillAboveBytes: 0,
		spillTargetBytes: 0,
		io: {
			...control.io,
			async readFile(path, range) {
				entered.resolve(path);
				await gate.promise;
				return control.io.readFile(path, range);
			},
		},
	});
	const ref = store.createLeaf("survives");
	await store.idle();
	const reading = store.readLeaf(ref).then(
		() => undefined,
		(error: unknown) => error,
	);
	const path = await entered.promise;
	store.adjust(ref, -1, 0);
	const retirement = store.retire();
	await store.idle();
	const heldSize = await stat(path).then(
		(file) => file.size,
		() => -1,
	);
	gate.resolve();
	const error = await reading;
	await retirement;
	expect(error).toMatchObject({ name: "CompactReadError", reason: "retired" });
	expect(heldSize).toBe(16);
	await expect(stat(root.dir)).rejects.toMatchObject({ code: "ENOENT" });
});
