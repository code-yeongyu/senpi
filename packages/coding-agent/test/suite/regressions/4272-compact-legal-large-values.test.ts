import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { CompactComponentRoots } from "../../../src/modes/rpc/compact-component-roots.ts";
import { CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import { CompactCurrentComponents } from "../../../src/modes/rpc/compact-current-components.ts";
import type { CompactStorageIo } from "../../../src/modes/rpc/compact-storage-io.ts";
import { CompactValues, type ValueRef, type ValueStep } from "../../../src/modes/rpc/compact-values.ts";
import { memoryIo, spoolRoot } from "../compact-storage-support.ts";

// senpi#4272 S03b-4 (S10-Q2): a value that is legal at the protocol level is owned by the compact store and read
// back through the component-root reader with owned per-step limits only (one bounded page at a time); the old
// aggregate 16 MiB / depth 128 / 100,000-node caps of the whole-value convenience API are not protocol limits.

const MiB = 1024 * 1024;
const valid = () => {};
const sha256 = (text: string) => createHash("sha256").update(Buffer.from(text, "utf16le")).digest("hex");

async function withRoots<T extends object>(
	run: (store: CompactContentStore, roots: CompactComponentRoots<T>) => Promise<void>,
	io?: CompactStorageIo,
) {
	const root = await spoolRoot();
	const store = new CompactContentStore({ dir: root.dir, io });
	try {
		await run(store, new CompactComponentRoots<T>(store, () => []));
		await store.idle();
		expect(store.status().structuredBytes, "every owned leaf left with its root").toEqual({
			resident: 0,
			spilled: 0,
			pinned: 0,
		});
		expect(store.text.residentNodes).toBe(0);
	} finally {
		await store.retire();
		await root.cleanup();
	}
}

it("owns a 34 MiB string field through component roots and streams it back exactly with one page resident", async () => {
	// 17 Mi code units: twice the old 16 MiB UTF-16 string cap; the leading "a" splits a surrogate pair at every page edge.
	const body = `a${"\u{1F600}".repeat((17 * MiB - 1) / 2)}`;
	await withRoots<{ body: string }>(async (store, roots) => {
		const root = roots.set({ header: undefined, ref: undefined }, "0000000000000000", { body });
		expect(
			store.status().structuredBytes.resident,
			"owned synchronously, in 4,096-unit pages",
		).toBeGreaterThanOrEqual(body.length * 2);
		await store.idle();
		expect(store.status().structuredBytes.resident, "the store spilled every page").toBe(0);
		const values = new CompactValues(store);
		const hash = createHash("sha256");
		const heapBefore = process.memoryUsage().heapUsed;
		let heapPeak = heapBefore;
		let maxChunk = 0;
		let steps = 0;
		let rows = 0;
		for await (const [key, ref] of roots.rows(root.ref, valid)) {
			rows++;
			expect(key).toBe("0000000000000000");
			const shape: string[] = [];
			let field = "";
			for await (const step of values.walk(ref, valid)) {
				steps++;
				if (shape.length < 3) shape.push(step.kind);
				if (step.kind === "string") {
					if (shape.length <= 2) field += step.text;
					else {
						hash.update(Buffer.from(step.text, "utf16le"));
						maxChunk = Math.max(maxChunk, step.text.length);
					}
				}
				expect(values.residentPages, "at most one value page is held between steps").toBeLessThanOrEqual(1);
				if (steps % 64 === 0) {
					(globalThis as { gc?: () => void }).gc?.();
					heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
				}
			}
			expect(shape).toEqual(["open", "string", "string"]);
			expect(field).toBe("body");
		}
		expect(rows).toBe(1);
		expect(hash.digest("hex")).toBe(sha256(body));
		expect(maxChunk).toBeLessThanOrEqual(4096);
		expect(values.peakResidentPages).toBe(1);
		console.log(
			`S03b-4 measured: ${steps} steps, heap peak delta ${((heapPeak - heapBefore) / MiB).toFixed(1)} MiB (${
				"gc" in globalThis ? "after gc" : "no gc"
			}) for a ${((body.length * 2) / MiB).toFixed(0)} MiB value`,
		);
		roots.release(root);
	});
}, 120_000);

it("owns a value with 100,001 nodes through component roots and reads it back exactly", async () => {
	const items = Array.from({ length: 100_001 }, (_, n) => n);
	await withRoots<{ items: number[] }>(async (store, roots) => {
		const root = roots.set({ header: undefined, ref: undefined }, "0000000000000000", { items });
		await store.idle();
		const entries: unknown[] = [];
		for await (const entry of roots.entries(root.ref, valid)) entries.push(entry);
		expect(entries).toEqual([["0000000000000000", { items }]]);
		roots.release(root);
	});
}, 120_000);

/** RULING-59 (1): arrays and objects alternate, so both container walks reach this depth; the innermost value is paged. */
const DEEP = 100_000;
const DEEP_TAIL = "x".repeat(5000);
function deepValue(): unknown {
	let nested: unknown = DEEP_TAIL;
	for (let level = 0; level < DEEP; level++) nested = level % 2 ? { d: nested } : [nested];
	return nested;
}
/** The first level (outermost 0) where `read` differs from `deepValue()`, or -1; iterative, so no matcher recurses. */
function deepMismatch(read: unknown): number {
	for (let level = DEEP - 1; level >= 0; level--) {
		const inner: unknown =
			level % 2
				? typeof read === "object" && read !== null && !Array.isArray(read) && Object.keys(read).join() === "d"
					? Reflect.get(read, "d")
					: undefined
				: Array.isArray(read) && read.length === 1
					? read[0]
					: undefined;
		if (inner === undefined) return DEEP - 1 - level;
		read = inner;
	}
	return read === DEEP_TAIL ? -1 : DEEP;
}
async function deepSteps(values: CompactValues, ref: ValueRef) {
	const kinds = new Map<ValueStep["kind"], number>();
	let text = "";
	let tails = 0;
	for await (const step of values.walk(ref, valid)) {
		kinds.set(step.kind, (kinds.get(step.kind) ?? 0) + 1);
		if (step.kind !== "string") continue;
		text += step.text;
		if (step.more) continue;
		if (text === DEEP_TAIL) tails++;
		text = "";
	}
	return { open: kinds.get("open"), close: kinds.get("close"), text: tails === 1 };
}

it("owns, walks, reads, pins, merges and releases a value nested 100,000 deep with one page resident", async () => {
	const root = await spoolRoot();
	const store = new CompactContentStore({ dir: root.dir, io: memoryIo() });
	try {
		const ref = new CompactValues(store).own(deepValue());
		await store.idle();
		const walker = new CompactValues(store);
		expect(await deepSteps(walker, ref)).toEqual({ open: DEEP, close: DEEP, text: true });
		expect(walker.peakResidentPages).toBe(1);
		const reader = new CompactValues(store);
		expect(deepMismatch(await reader.read(ref, valid))).toBe(-1);
		expect(reader.peakResidentPages).toBe(1);
		// The live reference goes while a cut pin holds the root: the pinned-only transition crosses every level.
		const { resident, spilled } = store.status().structuredBytes;
		store.adjust(ref.owner, 0, 1);
		store.adjust(ref.owner, -1, 0);
		expect(store.status().structuredBytes.pinned, "every page is pinned-only").toBe(resident + spilled);
		const pinned = new CompactValues(store);
		expect(await deepSteps(pinned, ref)).toEqual({ open: DEEP, close: DEEP, text: true });
		expect(pinned.peakResidentPages).toBe(1);
		store.adjust(ref.owner, 0, -1);
		await store.idle();
		expect(store.status().structuredBytes).toEqual({ resident: 0, spilled: 0, pinned: 0 });
		expect(store.text.residentNodes).toBe(0);
		// merge copies the deep field's descriptor; the merged value walks to the same depth plus its own object.
		const codec = new CompactValues(store);
		const base = codec.own({ deep: deepValue() });
		const merged = await codec.merge(base, new Map([["next", { node: 0, owner: 0, value: 1 }]]));
		store.adjust(base.owner, -1, 0);
		const after = new CompactValues(store);
		expect(await deepSteps(after, merged)).toEqual({ open: DEEP + 1, close: DEEP + 1, text: true });
		expect(after.peakResidentPages).toBe(1);
		store.adjust(merged.owner, -1, 0);
		await store.idle();
		expect(store.status().structuredBytes).toEqual({ resident: 0, spilled: 0, pinned: 0 });
		expect(store.text.residentNodes).toBe(0);
	} finally {
		await store.retire();
		await root.cleanup();
	}
}, 120_000);

it("owns a value nested 100,000 deep through component roots without recursion and reads it back exactly", async () => {
	const nested = deepValue();
	await withRoots<{ nested: unknown }>(async (store, roots) => {
		const root = roots.set({ header: undefined, ref: undefined }, "0000000000000000", { nested });
		await store.idle();
		let read: unknown;
		for await (const [, row] of roots.entries(root.ref, valid)) read = row.nested;
		expect(deepMismatch(read)).toBe(-1);
		const values = new CompactValues(store);
		for await (const [, ref] of roots.rows(root.ref, valid))
			expect(await deepSteps(values, ref)).toEqual({ open: DEEP + 1, close: DEEP + 1, text: true });
		expect(values.peakResidentPages).toBe(1);
		roots.release(root);
	}, memoryIo());
}, 120_000);

it("keeps a broadcast question whose request has 100,001 nodes as a dialog of the cut", async () => {
	const root = await spoolRoot();
	const store = new CompactContentStore({ dir: root.dir, io: memoryIo() });
	try {
		const components = new CompactCurrentComponents(store);
		const request = {
			type: "extension_ui_request",
			method: "question",
			id: "q1",
			deadlineAtMs: 10,
			questions: Array.from({ length: 100_001 }, (_, n) => n),
		};
		components.apply(request);
		const frozen = components.freeze();
		await store.idle();
		const view = await components.read(frozen, valid);
		expect(view.dialogs).toEqual([
			{ id: "q1", audience: "broadcast", method: "question", deadlineAtMs: 10, request },
		]);
		components.release(frozen);
	} finally {
		await store.retire();
		await root.cleanup();
	}
}, 120_000);
