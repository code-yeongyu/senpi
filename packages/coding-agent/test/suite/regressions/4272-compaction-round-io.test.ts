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

// senpi#4272 / RULING-47: a round writes one segment of its surviving nodes, plus its page and owner marker.
it("packs each compaction round into one segment file and writes no node it replaced", async () => {
	const root = await spoolRoot();
	const files = new Map<string, Buffer>();
	let creates = 0;
	let deletes = 0;
	const store = new CompactContentStore({
		dir: root.dir,
		io: {
			async writeFile(path, data) {
				creates++;
				files.set(path, Buffer.from(data));
			},
			async readFile(path, range) {
				const data = files.get(path);
				if (!data) throw new Error("missing backing file");
				return Buffer.from(range ? data.subarray(range.offset, range.offset + range.length) : data);
			},
			async unlink(path) {
				deletes++;
				files.delete(path);
			},
		},
	});
	const count = 8192;
	const index = new CompactContentIndex<{ n: number }>(store, () => [], 1);
	const tree = index.bases as unknown as {
		cached<R>(operation: () => Promise<R>): Promise<R>;
		make(node: object): Promise<PagedRoot>;
	};
	const leaves: ReadonlyMap<LeafId, unknown> = store["leaves"];
	const rounds: Round[] = [];
	const current = () => rounds[rounds.length - 1];
	let peakResident = 0;
	let nodeBytes = 0;
	let height = 0;
	const cached = tree.cached.bind(tree);
	const make = tree.make.bind(tree);
	const pause = vi.spyOn(index["compactor"], "schedule").mockImplementation(() => undefined);
	try {
		for (let n = 0; n < count; n++) index.set(String(n).padStart(5, "0"), { n });
		await store.idle();
		pause.mockRestore();
		const before = { creates, deletes, allocated: index.bases.allocatedNodes };
		store.subscribeCommitted((id) => {
			if (current()?.built.has(id)) current().written.add(id);
		});
		vi.spyOn(tree, "cached").mockImplementation(async (operation) => {
			const round: Round = { start: creates, built: new Set(), written: new Set(), survivors: 0, deadWrites: 0 };
			rounds.push(round);
			try {
				return await cached(operation);
			} finally {
				round.survivors = [...round.built].filter((id) => leaves.has(id)).length;
				round.deadWrites = [...round.written].filter((id) => !leaves.has(id)).length;
			}
		});
		vi.spyOn(tree, "make").mockImplementation(async (node) => {
			const made = await make(node);
			current().built.add(made.ref.node);
			peakResident = Math.max(peakResident, store.status().structuredBytes.resident);
			nodeBytes = Math.max(nodeBytes, store.leafUnits(made.ref.node) * 2);
			height = Math.max(height, made.height);
			return made;
		});
		index.maybeCompact();
		await store.idle();
		expect(rounds.length).toBeGreaterThanOrEqual(count / 128);
		// A round's resident nodes are its surviving draft plus the one path it is rebuilding (3 nodes per
		// level): neither a deferred flush nor a round that keeps replaced nodes alive fits under this.
		const survivors = Math.max(...rounds.map((round) => round.survivors));
		expect(peakResident).toBeGreaterThan(0);
		expect(peakResident, "peak resident structured bytes").toBeLessThanOrEqual(
			(survivors + 3 * (height + 1)) * nodeBytes,
		);
		// RULING-47: a round builds each changed node once, so paged-node allocations stay within 1.5x the nodes
		// that survive their round; the survivors themselves are at most the rows plus one rebuilt path per round.
		const survived = rounds.reduce((sum, round) => sum + round.survivors, 0);
		const allocated = index.bases.allocatedNodes - before.allocated;
		expect(survived, "nodes surviving their round").toBeLessThanOrEqual(count + rounds.length * (height + 1));
		expect(allocated, "paged-node allocations").toBeLessThanOrEqual(1.5 * survived);
		const folded = { creates: creates - before.creates, deletes: deletes - before.deletes };
		expect(folded.creates, "fold file creates").toBeLessThanOrEqual(3 * rounds.length);
		expect(folded.deletes, "fold file deletes").toBeLessThanOrEqual(folded.creates);
		for (const [n, round] of rounds.entries()) {
			const roundCreates = (rounds[n + 1]?.start ?? creates) - round.start;
			expect(roundCreates, `round ${n} file creates`).toBeLessThanOrEqual(3);
			expect(round.deadWrites, `round ${n} writes of replaced nodes`).toBe(0);
		}
		expect(index.status()).toMatchObject({ baseRows: count, overrideSlots: 0 });
		expect(store.status()).toMatchObject({ structuredBytes: { resident: 0 }, failures: [] });
		const cut = index.freeze();
		try {
			const rows = await index.entries(cut);
			expect(rows.size).toBe(count);
			expect(rows.get("04097")).toEqual({ n: 4097 });
		} finally {
			index.release(cut);
		}
	} finally {
		vi.restoreAllMocks();
		await store.retire();
		await root.cleanup();
	}
}, 120_000);
