import { basename } from "node:path";
import { expect, it } from "vitest";
import type { FrozenIndex } from "../../../src/modes/rpc/compact-content-index.ts";
import type { CompactStorageIo } from "../../../src/modes/rpc/compact-storage-io.ts";
import { controlledIo, type IoHold } from "../compact-storage-support.ts";
import { SPREAD_KEYS, spreadRoundRig, spreadSpoolRoot } from "./4272-spread-round-support.ts";

const ROWS = 1_024;
/** Node files of the deterministic 1,024-row spread round (533,538 node bytes); RULING-55 asks for at least 7. */
const ROUND_NODE_FILES = 9;
const isNodeFile = (path: string) => basename(path).startsWith("node-");

interface HeldView {
	readonly file: string;
	readonly base: unknown;
	readonly pages: readonly unknown[];
	readonly status: object;
	readonly rows: Map<string, { n: number }>;
	/** Files this reader read, so reads of the unpublished round can be found once its file set is known. */
	readonly reads: readonly string[];
}

// senpi#4545 / RULING-55 condition 2: while a multi-file compaction round is being written, a concurrent reader
// sees the whole previous state; once the round is published it sees the whole new round, never a mix.
it("serves concurrent readers the whole previous state until a multi-file round publishes, then the whole new round", async () => {
	const root = await spreadSpoolRoot();
	const controlled = controlledIo();
	const reads: string[] = [];
	const io: CompactStorageIo = {
		...controlled.io,
		async readFile(path, range) {
			reads.push(basename(path));
			return controlled.io.readFile(path, range);
		},
	};
	const rig = spreadRoundRig(ROWS, root.dir, io);
	const published = () => {
		const { baseRows, basePages, overrideSlots, deletionMasks } = rig.index.status();
		return { baseRows, basePages, overrideSlots, deletionMasks };
	};
	const read = async (cut: FrozenIndex) => {
		const from = reads.length;
		const rows = await rig.index.entries(cut);
		return { rows, reads: reads.slice(from) };
	};
	let hold: IoHold | undefined;
	let held: FrozenIndex | undefined;
	try {
		await rig.settle();
		const before = { base: rig.index.base, pages: [...rig.index.pages], status: published() };
		expect(before.status).toMatchObject({ baseRows: ROWS, overrideSlots: SPREAD_KEYS });
		const first = rig.index.freeze();
		const expected = await read(first).finally(() => rig.index.release(first));

		const views: HeldView[] = [];
		hold = controlled.hold("write", isNodeFile);
		const round = rig.round();
		for (;;) {
			const file = await Promise.race([hold.entered, round.then(() => undefined)]);
			if (file === undefined) break;
			// The round's node files before this one are on disk; this one and the commit are not yet.
			if (held) rig.index.release(held);
			held = rig.index.freeze();
			const view = await read(held);
			views.push({
				file: basename(file),
				base: held.base,
				pages: [...rig.index.pages],
				status: published(),
				...view,
			});
			const current = hold;
			hold = controlled.hold("write", isNodeFile);
			current.release();
		}
		const roundFiles = new Set((await round).map((file) => file.name));
		const nodes = [...roundFiles].filter((name) => name.startsWith("node-"));
		const during = views.filter((view) => roundFiles.has(view.file));
		expect(nodes.length, "node files in the round").toBe(ROUND_NODE_FILES);
		expect(
			during.map((view) => view.file),
			"a reader ran while each node file was held",
		).toEqual(nodes);
		for (const view of during) {
			const at = `reader while ${view.file} was held`;
			expect(view.base, at).toBe(before.base);
			expect(view.pages, at).toEqual(before.pages);
			expect(view.status, at).toEqual(before.status);
			expect(view.rows, at).toEqual(expected.rows);
			expect(
				view.reads.filter((name) => roundFiles.has(name)),
				`${at}: reads of the unpublished round`,
			).toEqual([]);
		}

		// Published: a new reader sees the whole new round and reads it from the round's own files.
		expect(rig.index.base).not.toBe(before.base);
		expect(rig.index.status()).toMatchObject({ baseRows: ROWS + SPREAD_KEYS, overrideSlots: 0 });
		const after = rig.index.freeze();
		const next = await read(after).finally(() => rig.index.release(after));
		expect(next.rows).toEqual(expected.rows);
		expect(
			next.reads.filter((name) => nodes.includes(name)).length,
			"reads of the published round's node files",
		).toBeGreaterThan(0);

		// A cut taken before publication still reads only the previous state after it.
		if (!held) throw new Error("no reader ran during the round");
		const old = await read(held);
		expect(held.base).toBe(before.base);
		expect(old.rows).toEqual(expected.rows);
		expect(
			old.reads.filter((name) => roundFiles.has(name)),
			"reads of the new round through a pre-publication cut",
		).toEqual([]);
	} finally {
		if (held) rig.index.release(held);
		hold?.release();
		await rig.store.retire();
		await root.cleanup();
	}
}, 120_000);
