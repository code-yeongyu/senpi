import { expect, it, vi } from "vitest";
import { CompactContentIndex } from "../../../src/modes/rpc/compact-content-index.ts";
import { CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import { spoolRoot } from "../compact-storage-support.ts";

// senpi#4559: a round's batched apply walks the paths its selection lookup just decoded. With rows ready in an
// order scattered over the key space (random ids), those paths only survive to the apply if the round cache holds
// them; otherwise every path is hydrated from the spool twice per round.
it("reuses the selection's decoded paths in the apply of the same round", async () => {
	const count = 8000;
	const root = await spoolRoot();
	const files = new Map<string, Buffer>();
	const store = new CompactContentStore({
		dir: root.dir,
		io: {
			async writeFile(path, data) {
				files.set(path, Buffer.from(data));
			},
			async readFile(path, range) {
				const data = files.get(path);
				if (!data) throw new Error("missing backing file");
				return Buffer.from(range ? data.subarray(range.offset, range.offset + range.length) : data);
			},
			async unlink(path) {
				files.delete(path);
			},
		},
	});
	const index = new CompactContentIndex<{ n: number }>(store, () => [], 128);
	let phase: "select" | "apply" | "other" = "other";
	const hydrations = { select: 0, apply: 0, other: 0 };
	const readLeaf = store.readLeaf.bind(store);
	vi.spyOn(store, "readLeaf").mockImplementation((id) => {
		hydrations[phase]++;
		return readLeaf(id);
	});
	const getMany = index.bases.getMany.bind(index.bases);
	vi.spyOn(index.bases, "getMany").mockImplementation(async (base, keys) => {
		phase = "select";
		try {
			return await getMany(base, keys);
		} finally {
			phase = "other";
		}
	});
	const apply = index.bases.apply.bind(index.bases);
	vi.spyOn(index.bases, "apply").mockImplementation(async (base, changes) => {
		phase = "apply";
		try {
			return await apply(base, changes);
		} finally {
			phase = "other";
		}
	});
	let rounds = 0;
	const cached = index.bases.cached.bind(index.bases);
	vi.spyOn(index.bases, "cached").mockImplementation((operation) => {
		rounds++;
		return cached(operation);
	});
	try {
		// 1031 is prime and coprime to 8000, so n -> n * 1031 mod 8000 visits every key once, scattered over the keys.
		for (let n = 0; n < count; n++) index.set(`k${String((n * 1031) % count).padStart(5, "0")}`, { n });
		await store.idle();
		expect(index.status().baseRows).toBeGreaterThan(count - 128);
		expect(hydrations.select).toBeGreaterThan(rounds * 128);
		// At most one rebuilt path per round may miss: the apply otherwise reads only what the selection decoded.
		expect(hydrations.apply).toBeLessThanOrEqual(rounds * Math.ceil(Math.log2(count)));
	} finally {
		vi.restoreAllMocks();
		await store.retire();
		await root.cleanup();
	}
}, 120_000);
