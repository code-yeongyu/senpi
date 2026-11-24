import { afterEach, expect, it, vi } from "vitest";
import { writtenComponent } from "../../../src/modes/rpc/compact-catalog-writer.ts";
import { COMPACT_LEAF_CODE_UNITS, CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import { CompactReadError } from "../../../src/modes/rpc/compact-read-lease.ts";
import { FRAGMENT_MAX_BYTES, producePage, type RecoveryPage } from "../../../src/modes/rpc/compact-recovery-bytes.ts";
import { type CatalogComponent, CompactRecoveryCatalog } from "../../../src/modes/rpc/compact-recovery-catalog.ts";
import { catalogRootRef, childRef, protocolId } from "../../../src/modes/rpc/compact-recovery-ids.ts";
import { controlledIo, spoolRoot } from "../compact-storage-support.ts";
import { component, componentBytes, specDigest } from "./4272-frozen-bytes-support.ts";

// Part of #4272 (S11a, R4.B3, X04/T5, RULING-58 (1), RULING-59 A): a frozen component is a stream of its exact stored
// UTF-16LE bytes addressed by raw byte offset; a page is at most D raw bytes with its own fragment digest; the stream is
// verified against the catalog entry before any byte is served and holds one stored leaf resident, whatever the size.

afterEach(() => {
	vi.restoreAllMocks();
});

const LEAF = COMPACT_LEAF_CODE_UNITS;
const D_UNITS = FRAGMENT_MAX_BYTES / 2;

/**
 * A JSON string whose stored code units put a surrogate pair across the first leaf edge, a lone surrogate across the
 * first fragment edge, a `\"` escape across the third leaf edge, a `\u00e9` escape across the second fragment edge (the
 * fourth leaf edge) and a pair across the fifth leaf edge, inside a text just over two and a half fragments.
 */
function fixtureText(): string {
	const marks = new Map<number, string>([
		[LEAF - 1, "\u{1F600}"],
		[D_UNITS - 1, "\uDBFF"],
		[3 * LEAF - 1, '\\"'],
		[2 * D_UNITS - 3, "\\u00e9"],
		[5 * LEAF - 1, "\u{1F600}"],
	]);
	const parts: string[] = ['"'];
	let length = 1;
	for (const [at, mark] of [...marks].sort(([a], [b]) => a - b)) {
		parts.push("x".repeat(at - length), mark);
		length = at + mark.length;
	}
	parts.push("y".repeat(Math.floor(2.5 * D_UNITS) + 64 - length - 1), '"');
	return parts.join("");
}

async function rig(text: string | ((push: (chunk: string) => void) => void)) {
	const root = await spoolRoot();
	const store = new CompactContentStore({ dir: root.dir, io: controlledIo().io });
	const catalogs = new CompactRecoveryCatalog();
	const components: CatalogComponent[] = [];
	const fill = typeof text === "string" ? (push: (chunk: string) => void) => push(text) : text;
	for await (const part of writtenComponent(store, protocolId("row"), protocolId("row-1"), (writer) =>
		fill((chunk) => writer.push(chunk)),
	)) {
		store.adjust(part.owner, 1, 0);
		components.push(part);
	}
	const catalog = await catalogs.build(store, catalogRootRef(1), components);
	for (const part of components) store.adjust(part.owner, -1, 0);
	return {
		store,
		catalogs,
		catalog,
		read: (valid?: () => void) => catalogs.read(store, catalog, childRef(catalog.ref, 0), valid),
		async close() {
			catalogs.release(store, catalog);
			await store.retire();
			await root.cleanup();
		},
	};
}

async function pages(read: Awaited<ReturnType<typeof CompactRecoveryCatalog.prototype.read>>) {
	const out: RecoveryPage[] = [];
	const bytes = component(read).bytes;
	for (let offset: number | null = 0; offset !== null;) {
		const page: RecoveryPage = await producePage(bytes, offset);
		out.push(page);
		offset = page.next;
	}
	return out;
}

it("X04 every surrogate, lone surrogate and JSON escape split across leaves and D-sized fragments pages back byte-exact at raw byte offsets", async () => {
	const text = fixtureText();
	const expected = Buffer.from(text, "utf16le");
	const fixture = await rig(text);
	try {
		const read = component(await fixture.read());
		expect("text" in read, "carry 43: the catalog never joins a component's text").toBe(false);
		expect(read.bytes.length).toBe(expected.length);
		expect(read.bytes.digest).toBe(specDigest("leaf", expected));
		expect(read.entry.digest).toBe(read.bytes.digest);
		const served = await pages(read);
		expect(served.map((page) => [page.offset, page.length, page.next, page.complete])).toEqual([
			[0, FRAGMENT_MAX_BYTES, FRAGMENT_MAX_BYTES, false],
			[FRAGMENT_MAX_BYTES, FRAGMENT_MAX_BYTES, 2 * FRAGMENT_MAX_BYTES, false],
			[2 * FRAGMENT_MAX_BYTES, expected.length - 2 * FRAGMENT_MAX_BYTES, null, true],
		]);
		expect(Buffer.concat(served.map((page) => page.bytes)).equals(expected)).toBe(true);
		for (const page of served) {
			expect(page.bytes.length).toBe(page.length);
			expect(page.digest).toBe(specDigest("fragment", page.bytes));
			expect(page.digest).not.toBe(specDigest("leaf", page.bytes));
		}
		for (const [offset, length] of [
			[1, 3],
			[2 * LEAF - 3, 6],
			[FRAGMENT_MAX_BYTES - 1, 2],
			[expected.length - 1, 1],
		] as const)
			expect((await read.bytes.range(offset, length)).equals(expected.subarray(offset, offset + length))).toBe(true);
		expect((await componentBytes(read, 7)).equals(expected), "any range step joins to the same bytes").toBe(true);
	} finally {
		await fixture.close();
	}
});

it("RULING-59 A a component over 16 MiB streams with one stored leaf resident beside the page, never a join", async () => {
	const units = 17 * 1024 * 1024 * 0.5;
	const piece = "p".repeat(1024);
	const fixture = await rig((push) => {
		for (let pushed = 0; pushed < units; pushed += piece.length) push(piece);
	});
	try {
		const read = component(await fixture.read());
		expect(read.bytes.length).toBe(units * 2);
		expect(read.bytes.length).toBeGreaterThan(16 * 1024 * 1024);
		const leaves = vi.spyOn(fixture.store, "readLeaf");
		let count = 0;
		let total = 0;
		for (let offset: number | null = 0; offset !== null;) {
			const page: RecoveryPage = await producePage(read.bytes, offset);
			expect(page.length).toBeLessThanOrEqual(FRAGMENT_MAX_BYTES);
			expect(page.digest).toBe(specDigest("fragment", page.bytes));
			count += 1;
			total += page.length;
			offset = page.next;
		}
		expect(count).toBe(Math.ceil((units * 2) / FRAGMENT_MAX_BYTES));
		expect(total).toBe(units * 2);
		expect(read.bytes.peakResidentLeaves, "one stored leaf at a time").toBe(1);
		expect(leaves.mock.calls.length, "D-aligned pages read each stored leaf exactly once").toBe(
			Math.ceil(units / LEAF),
		);
	} finally {
		await fixture.close();
	}
});

it("T5 X04 a malformed or out-of-range request is refused typed before any byte is read; a page never exceeds D", async () => {
	const fixture = await rig("abc");
	try {
		const read = component(await fixture.read());
		const reads = vi.spyOn(fixture.store, "readLeaf");
		for (const [offset, length] of [
			[-1, 1],
			[0.5, 1],
			[Number.NaN, 1],
			[0, -1],
			[7, 0],
			[0, 7],
			[2, 5],
		] as const)
			await expect(read.bytes.range(offset, length), `range ${offset}+${length}`).rejects.toMatchObject({
				name: "CompactReadError",
				reason: "range",
			});
		await expect(read.bytes.range(0, FRAGMENT_MAX_BYTES + 1)).rejects.toMatchObject({ reason: "size_limit" });
		for (const offset of [6, 7, -1, 1.5])
			await expect(producePage(read.bytes, offset)).rejects.toMatchObject({ reason: "range" });
		expect(reads).not.toHaveBeenCalled();
		expect(await producePage(read.bytes, 0)).toMatchObject({ offset: 0, length: 6, next: null, complete: true });
	} finally {
		await fixture.close();
	}
});

it("X04 an empty component is one complete empty page", async () => {
	const fixture = await rig("");
	try {
		const page = await producePage(component(await fixture.read()).bytes, 0);
		expect(page).toMatchObject({ offset: 0, length: 0, next: null, complete: true });
		expect(page.bytes.length).toBe(0);
		expect(page.digest).toBe(specDigest("fragment", Buffer.alloc(0)));
	} finally {
		await fixture.close();
	}
});

it("RULING-57 (3) a flipped stored byte refuses the component as integrity before any byte source exists", async () => {
	const fixture = await rig("x".repeat(LEAF + 10));
	try {
		const readLeaf = fixture.store.readLeaf.bind(fixture.store);
		vi.spyOn(fixture.store, "readLeaf").mockImplementation(async (id) => {
			const text = await readLeaf(id);
			return text.length === 10 ? `${text.slice(0, 9)}y` : text;
		});
		await expect(fixture.read()).rejects.toMatchObject({ name: "CompactReadError", reason: "integrity" });
	} finally {
		await fixture.close();
	}
});

it("RULING-59 A (2) the lease is rechecked between stored leaf reads while verifying and while serving a range", async () => {
	const fixture = await rig("x".repeat(3 * LEAF));
	try {
		let checks = 0;
		const valid = () => {
			if (++checks === 2) throw new CompactReadError("released");
		};
		await expect(fixture.read(valid)).rejects.toMatchObject({ reason: "released" });
		expect(checks).toBe(2);
		const read = component(await fixture.read());
		checks = 0;
		await expect(read.bytes.range(0, FRAGMENT_MAX_BYTES, valid)).rejects.toMatchObject({ reason: "released" });
		expect(checks).toBe(2);
		checks = -10;
		expect((await read.bytes.range(0, FRAGMENT_MAX_BYTES, valid)).length).toBe(FRAGMENT_MAX_BYTES);
		expect(checks).toBe(-8);
	} finally {
		await fixture.close();
	}
});
