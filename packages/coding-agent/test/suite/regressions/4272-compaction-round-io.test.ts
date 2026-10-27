import { expect, it, vi } from "vitest";
import { CompactContentIndex } from "../../../src/modes/rpc/compact-content-index.ts";
import { CompactContentStore, type LeafId } from "../../../src/modes/rpc/compact-content-store.ts";
import type { PagedRoot } from "../../../src/modes/rpc/compact-paged-tree.ts";
import { spoolRoot } from "../compact-storage-support.ts";

interface Round {
	readonly start: number;
	readonly built: Set<LeafId>;
	readonly written: Set<LeafId>;
	survivors: number;
	deadWrites: number;
}

// senpi#4272: a compaction round writes the index nodes that survive it, plus its page and owner marker.
it("persists only the surviving nodes of each compaction round", async () => {
	const root = await spoolRoot();
	const files = new Map<string, Buffer>();
	let creates = 0;
	const store = new CompactContentStore({
		dir: root.dir,
		io: {
			async writeFile(path, data) {
				creates++;
				files.set(path, Buffer.from(data));
			},
			async readFile(path) {
				const data = files.get(path);
				if (!data) throw new Error("missing backing file");
				return Buffer.from(data);
			},
			async unlink(path) {
				files.delete(path);
			},
		},
	});
	const count = 8192;
	const index = new CompactContentIndex<{ n: number }>(store, () => [], 1);
	const tree = index.bases as unknown as {
		cached<R>(operation: () => Promise<R>): Promise<R>;
		make(node: object): Promise<PagedRoot>;
		flush(): Promise<void>;
	};
	const leaves: ReadonlyMap<LeafId, unknown> = store["leaves"];
	const rounds: Round[] = [];
	const current = () => rounds[rounds.length - 1];
	let peakResident = 0;
	let nodeBytes = 0;
	let height = 0;
	const cached = tree.cached.bind(tree);
	const make = tree.make.bind(tree);
	const flush = tree.flush.bind(tree);
	const flushLeaf = store.flushLeaf.bind(store);
	const pause = vi.spyOn(index["compactor"], "schedule").mockImplementation(() => undefined);
	try {
		for (let n = 0; n < count; n++) index.set(String(n).padStart(5, "0"), { n });
		await store.idle();
		pause.mockRestore();
		vi.spyOn(tree, "cached").mockImplementation((operation) => {
			rounds.push({ start: creates, built: new Set(), written: new Set(), survivors: 0, deadWrites: 0 });
			return cached(operation);
		});
		vi.spyOn(tree, "make").mockImplementation(async (node) => {
			const made = await make(node);
			current().built.add(made.ref.node);
			peakResident = Math.max(peakResident, store.status().structuredBytes.resident);
			nodeBytes = Math.max(nodeBytes, store.leafUnits(made.ref.node) * 2);
			height = Math.max(height, made.height);
			return made;
		});
		vi.spyOn(store, "flushLeaf").mockImplementation(async (id) => {
			await flushLeaf(id);
			if (current()?.built.has(id) && store.isCommitted(id)) current().written.add(id);
		});
		vi.spyOn(tree, "flush").mockImplementation(async () => {
			const round = current();
			round.survivors = [...round.built].filter((id) => leaves.has(id)).length;
			await flush();
			round.deadWrites = [...round.written].filter((id) => !leaves.has(id)).length;
		});
		index.maybeCompact();
		await store.idle();
		expect(rounds.length).toBeGreaterThanOrEqual(count / 128);
		const survivors = rounds.reduce((sum, round) => sum + round.survivors, 0);
		expect(creates - rounds[0].start, "fold file creates").toBeLessThanOrEqual(survivors + 2 * rounds.length);
		for (const [n, round] of rounds.entries()) {
			const roundCreates = (rounds[n + 1]?.start ?? creates) - round.start;
			expect(roundCreates, `round ${n} file creates`).toBeLessThanOrEqual(round.survivors + 2);
			expect(round.deadWrites, `round ${n} writes of replaced nodes`).toBe(0);
		}
		// A round holds at most 384 keys (128 selected rows plus two pages of at most 128 rows); each set
		// builds at most 3 nodes per level over height + 1 levels, and only those stay resident until commit.
		expect(peakResident).toBeGreaterThan(0);
		expect(peakResident).toBeLessThanOrEqual(384 * 3 * (height + 1) * nodeBytes);
		expect(index.status()).toMatchObject({ baseRows: count, overrideSlots: 0 });
		expect(store.status()).toMatchObject({ structuredBytes: { resident: 0 }, failures: [] });
	} finally {
		vi.restoreAllMocks();
		await store.retire();
		await root.cleanup();
	}
}, 120_000);
