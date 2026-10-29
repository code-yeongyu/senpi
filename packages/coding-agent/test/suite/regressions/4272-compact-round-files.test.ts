import { expect, it } from "vitest";
import { memoryIo, SPREAD_KEYS, spreadRoundRig, spreadSpoolRoot } from "./4272-spread-round-support.ts";

const PAGE_BYTES = 65_536;

// senpi#4539 / RULING-54 (part of #4272): a compaction round's node set is written as `node-` files of at
// most 64 KiB, ceil(round bytes / 64 KiB) of them, next to the round's one page; no file ever exceeds the bound.
// The spread rig is deterministic, so each size packs the same node files on every host and run.
it.each([
	[1_024, 9],
	[8_192, 14],
	[65_536, 20],
])(
	"writes a spread-key round over %i rows as %i node files of at most 64 KiB, ceil(bytes / 64 KiB) of them",
	async (count, nodeFiles) => {
		const root = await spreadSpoolRoot();
		const rig = spreadRoundRig(count, root.dir, memoryIo());
		try {
			await rig.settle();
			expect(rig.index.status()).toMatchObject({ baseRows: count, overrideSlots: SPREAD_KEYS });
			const round = await rig.round();
			expect(rig.index.status()).toMatchObject({ baseRows: count + SPREAD_KEYS, overrideSlots: 0 });
			expect(rig.store.status()).toMatchObject({ structuredBytes: { resident: 0 }, failures: [] });
			for (const file of round) expect(file.bytes, `${file.name} bytes`).toBeLessThanOrEqual(PAGE_BYTES);
			const pages = round.filter((file) => file.name.startsWith("page-"));
			const nodes = round.filter((file) => !file.name.startsWith("page-"));
			const nodeBytes = nodes.reduce((sum, file) => sum + file.bytes, 0);
			expect(pages.length, "page files").toBe(1);
			expect(
				nodes.every((file) => file.name.startsWith("node-")),
				"round node files carry the node- prefix",
			).toBe(true);
			expect(nodes.length, "node files").toBe(nodeFiles);
			expect(nodes.length, `node files for ${nodeBytes} round bytes`).toBe(Math.ceil(nodeBytes / PAGE_BYTES));
			expect(round.length, "round file creates").toBe(nodes.length + pages.length);
			const cut = rig.index.freeze();
			try {
				const rows = await rig.index.entries(cut);
				expect(rows.size).toBe(count + SPREAD_KEYS);
				expect(rows.get(rig.spreadKey(0))).toEqual({ n: 0 });
				expect(rows.get(rig.spreadKey(SPREAD_KEYS - 1))).toEqual({ n: 1 - SPREAD_KEYS });
			} finally {
				rig.index.release(cut);
			}
		} finally {
			await rig.store.retire();
			await root.cleanup();
		}
	},
	120_000,
);

// RULING-54 condition 2: a reader of the committed round holds at most one 64 KiB page per file read and
// never a whole round, during point lookups and a complete traversal alike.
it("reads a multi-file round one bounded page at a time, never a whole round", async () => {
	const root = await spreadSpoolRoot();
	const files = new Map<string, Buffer>();
	const io = memoryIo(files);
	const reads: { readonly bytes: number; readonly file: number; readonly inFlight: number }[] = [];
	let inFlight = 0;
	const rig = spreadRoundRig(1_024, root.dir, {
		...io,
		async readFile(path, range) {
			inFlight++;
			try {
				const data = await io.readFile(path, range);
				reads.push({ bytes: data.byteLength, file: files.get(path)?.byteLength ?? -1, inFlight });
				return data;
			} finally {
				inFlight--;
			}
		},
	});
	try {
		await rig.settle();
		const round = await rig.round();
		expect(round.filter((file) => !file.name.startsWith("page-")).length).toBe(9);
		reads.length = 0;
		const cut = rig.index.freeze();
		try {
			for (const k of [0, 37, SPREAD_KEYS - 1]) {
				expect(await rig.index.lookup(cut, rig.spreadKey(k))).toBeDefined();
			}
			expect((await rig.index.entries(cut)).size).toBe(1_024 + SPREAD_KEYS);
		} finally {
			rig.index.release(cut);
		}
		expect(reads.length).toBeGreaterThan(0);
		expect(Math.max(...reads.map((read) => read.bytes)), "largest read").toBeLessThanOrEqual(PAGE_BYTES);
		expect(Math.max(...reads.map((read) => read.file)), "largest file read from").toBeLessThanOrEqual(PAGE_BYTES);
		expect(Math.max(...reads.map((read) => read.inFlight)), "reads in flight").toBe(1);
	} finally {
		await rig.store.retire();
		await root.cleanup();
	}
}, 60_000);
