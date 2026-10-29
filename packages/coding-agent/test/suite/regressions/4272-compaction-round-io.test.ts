import { basename } from "node:path";
import { expect, it, vi } from "vitest";
import { CompactContentIndex } from "../../../src/modes/rpc/compact-content-index.ts";
import { CompactContentStore, type LeafId } from "../../../src/modes/rpc/compact-content-store.ts";
import type { PagedRoot } from "../../../src/modes/rpc/compact-paged-tree.ts";
import { CompactSpoolStorage } from "../../../src/modes/rpc/compact-spool-storage.ts";
import type { CompactStorageIo } from "../../../src/modes/rpc/compact-storage-io.ts";
import { settledRig } from "./4272-settled-support.ts";
import { spreadSpoolRoot } from "./4272-spread-round-support.ts";

interface Round {
	readonly start: number;
	readonly built: Set<LeafId>;
	readonly written: Set<LeafId>;
	survivors: number;
	deadWrites: number;
}

const PAGE_BYTES = 65_536;

// senpi#4272 / RULING-47 as amended by RULING-54: a round writes its surviving nodes as node files of at most
// 64 KiB, ceil(round node bytes / 64 KiB) of them, plus its page and owner marker; it writes no node it replaced.
it("packs each compaction round into bounded node files and writes no node it replaced", async () => {
	const root = await spreadSpoolRoot();
	const files = new Map<string, Buffer>();
	const writes: { readonly name: string; readonly bytes: number; readonly job: string | undefined }[] = [];
	let deletes = 0;
	let job: string | undefined;
	const store = new CompactContentStore({
		dir: root.dir,
		io: {
			async writeFile(path, data) {
				writes.push({ name: basename(path), bytes: data.byteLength, job });
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
	const enqueue = store.enqueue.bind(store);
	store.enqueue = (operation, work) =>
		enqueue(operation, async () => {
			const outer = job;
			job = operation;
			try {
				await work();
			} finally {
				job = outer;
			}
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
		const before = { creates: writes.length, deletes, allocated: index.bases.allocatedNodes };
		store.subscribeCommitted((id) => {
			if (current()?.built.has(id)) current().written.add(id);
		});
		vi.spyOn(tree, "cached").mockImplementation(async (operation) => {
			const round: Round = {
				start: writes.length,
				built: new Set(),
				written: new Set(),
				survivors: 0,
				deadWrites: 0,
			};
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
		const folded = { creates: writes.length - before.creates, deletes: deletes - before.deletes };
		expect(folded.deletes, "fold file deletes").toBeLessThanOrEqual(folded.creates);
		for (const [n, round] of rounds.entries()) {
			const window = writes.slice(round.start, rounds[n + 1]?.start ?? writes.length);
			for (const file of window) expect(file.bytes, `round ${n} ${file.name} bytes`).toBeLessThanOrEqual(PAGE_BYTES);
			// Segment rewrites between rounds are reclaim jobs, bounded by 4272-segment-reclamation; the round's own
			// creates are its node files and its page, plus the page's owner marker that the next value_write job writes.
			const own = window.filter((file) => file.job === "page_write");
			const nodes = own.filter((file) => file.name.startsWith("node-"));
			const nodeBytes = nodes.reduce((sum, file) => sum + file.bytes, 0);
			expect(nodes.length, `round ${n} node files for ${nodeBytes} bytes`).toBe(Math.ceil(nodeBytes / PAGE_BYTES));
			expect(own.length, `round ${n} round-job file creates`).toBe(nodes.length + 1);
			expect(
				own.filter((file) => !file.name.startsWith("node-")).map((file) => file.name.replace(/-\d+\.bin$/, "")),
				`round ${n} the one non-node create is its page`,
			).toEqual(["page"]);
			const markers = window.filter((file) => file.job === "value_write").length;
			expect(markers, `round ${n} owner markers`).toBeLessThanOrEqual(1);
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

// senpi#4272 / RULING-47 (SP3): structural value leaves are committed one segment per batch, never one file
// per leaf, and a round never locates a key it cannot select.
it("commits each compaction round's structural value leaves as one segment on the 1,000-join path", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const files = new Map<string, Buffer>();
	// Storage jobs run one at a time, so the running job's operation attributes each file it creates.
	let running = "";
	const value = { creates: 0, reads: 0 };
	const roundStarts: number[] = [];
	const io: CompactStorageIo = {
		async writeFile(path, data) {
			// A segment rewrite is reclamation, bounded by 4272-segment-reclamation, not a structural flush.
			if (path.includes("/value-") && running !== "reclaim") value.creates++;
			files.set(path, Buffer.from(data));
		},
		async readFile(path, range) {
			// Node pages live in their own node-* files (SP4), so node reads count toward the round's read bound too.
			if (path.includes("/value-") || path.includes("/node-")) value.reads++;
			const data = files.get(path);
			if (!data) throw new Error("missing backing file");
			return Buffer.from(range ? data.subarray(range.offset, range.offset + range.length) : data);
		},
		async unlink(path) {
			files.delete(path);
		},
	};
	const enqueue = CompactSpoolStorage.prototype.enqueue;
	vi.spyOn(CompactSpoolStorage.prototype, "enqueue").mockImplementation(function (this: CompactSpoolStorage, op, job) {
		enqueue.call(this, op, async () => {
			// The compactor's page_write job is one round; creates up to the next round start belong to it.
			if (op === "page_write") roundStarts.push(value.creates);
			running = op;
			try {
				await job();
			} finally {
				running = "";
			}
		});
	});
	const rig = await settledRig({ io });
	try {
		const joins = 1000;
		for (let index = 0; index < joins; index++) {
			const { carrier } = rig.end();
			rig.manager.appendOwnedMessage(
				{ role: "user", content: "terminal", timestamp: 1 },
				{ recoveryOwner: carrier },
			);
			rig.lane.applyTranscript(rig.manager.drainTranscript());
		}
		await rig.lane.idle();
		// Each join leaves four structural overrides, folded 128 per round.
		const rounds = roundStarts.length;
		expect(rounds).toBeGreaterThan(0);
		expect(rounds, "compaction rounds").toBeLessThanOrEqual(Math.ceil((4 * joins) / 128));
		for (const [n, start] of roundStarts.entries()) {
			// Value and spill files only: one segment for the round's batch of structural leaves and one for the
			// value_write batch queued between rounds (one file per leaf made about 130 per round). The round's node
			// files are counted separately: each round writes exactly ceil(node bytes / 64 KiB) of them (SP4's case above).
			const creates = (roundStarts[n + 1] ?? value.creates) - start;
			expect(creates, `round ${n} structural value file creates`).toBeLessThanOrEqual(3);
		}
		// About 290 node reads per round once pending keys are skipped before lookup; about 1,230 before either fix.
		expect(value.reads, "structural value and node reads").toBeLessThanOrEqual(320 * rounds);
		expect(rig.lane.storageStatus()).toMatchObject({ residentPayloadBytes: 0, failures: [] });
		expect((await rig.cut()).owners).toHaveLength(joins);
	} finally {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await rig.close();
	}
}, 60_000);
