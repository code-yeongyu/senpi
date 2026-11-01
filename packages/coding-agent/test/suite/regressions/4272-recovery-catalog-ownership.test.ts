import { afterEach, expect, it, vi } from "vitest";
import { catalogDigest, storedBytes } from "../../../src/modes/rpc/compact-catalog-codec.ts";
import { CompactContentStore, CompactWriteError } from "../../../src/modes/rpc/compact-content-store.ts";
import { CompactReadError } from "../../../src/modes/rpc/compact-read-lease.ts";
import {
	type CatalogComponent,
	type CatalogRoot,
	CompactRecoveryCatalog,
} from "../../../src/modes/rpc/compact-recovery-catalog.ts";
import type { CompactStorageIo } from "../../../src/modes/rpc/compact-storage-io.ts";
import { catalogRootRef, childRef, protocolId } from "../../../src/modes/rpc/compact-recovery-ids.ts";
import { controlledIo, spoolRoot } from "../compact-storage-support.ts";

// Part of #4272 (S09a review fold): a failed catalog build leaves nothing behind whichever leaf creation fails, a
// component of any leaf count is cataloged with every stored leaf under 64 KiB, a pointer that names a missing leaf
// is corruption (`integrity`), and a node read carries only its public fields.

afterEach(() => {
	vi.restoreAllMocks();
});

type Components = (store: CompactContentStore) => CatalogComponent[];

const rows =
	(count: number): Components =>
	(store) =>
		Array.from({ length: count }, (_, n) => {
			const leaf = store.createLeaf(`component-${n}`, true);
			return {
				kind: protocolId("row"),
				id: protocolId(`row-${String(n).padStart(16, "0")}`),
				leaves: [leaf],
				owner: leaf,
			};
		});

const wideText = (count: number): string => Array.from({ length: count }, (_, n) => `${n};`).join("");

const wide =
	(count: number): Components =>
	(store) => {
		const leaves = Array.from({ length: count }, (_, n) => store.createLeaf(`${n};`));
		const owner = store.text.own(leaves);
		for (const leaf of leaves) store.adjust(leaf, -1, 0);
		return [{ kind: protocolId("row"), id: protocolId("wide"), leaves, owner }];
	};

async function rig(components: Components) {
	const root = await spoolRoot();
	const control = controlledIo();
	const written: number[] = [];
	const io: CompactStorageIo = {
		...control.io,
		writeFile: async (path, data) => {
			written.push(data.length);
			await control.io.writeFile(path, data);
		},
	};
	const store = new CompactContentStore({ dir: root.dir, io });
	const built = components(store);
	return {
		store,
		components: built,
		written,
		drop() {
			for (const { owner } of built) store.adjust(owner, -1, 0);
		},
		async close() {
			await store.retire();
			await root.cleanup();
		},
	};
}

const usage = (store: CompactContentStore) => {
	const status = store.status();
	return {
		...status.structuredBytes,
		payload: status.residentPayloadBytes + status.spilledLiveBytes + status.pinnedOnlyBytes,
		nodes: store.text.residentNodes,
	};
};

type Fault = { readonly method: "createLeaf" | "readLeaf"; readonly at: number };

const injected = (method: Fault["method"]) =>
	method === "createLeaf" ? new CompactWriteError("storage_unavailable") : new CompactReadError("unavailable");

/** One build on a fresh store, failing call `fault.at` of `fault.method`; a built root is released again. */
async function attempt(components: Components, fault?: Fault) {
	const fixture = await rig(components);
	try {
		await fixture.store.idle();
		const before = usage(fixture.store);
		const calls = { createLeaf: 0, readLeaf: 0 };
		const create = fixture.store.createLeaf.bind(fixture.store);
		const read = fixture.store.readLeaf.bind(fixture.store);
		const fail = (method: Fault["method"]) => {
			if (++calls[method] === fault?.at && fault.method === method) throw injected(method);
		};
		vi.spyOn(fixture.store, "createLeaf").mockImplementation((text, value) => {
			fail("createLeaf");
			return create(text, value);
		});
		vi.spyOn(fixture.store, "readLeaf").mockImplementation(async (id) => {
			fail("readLeaf");
			return read(id);
		});
		const catalogs = new CompactRecoveryCatalog();
		const outcome = await catalogs.build(fixture.store, catalogRootRef(1), fixture.components).then(
			(root) => ({ ok: true as const, root }),
			(cause: unknown) => ({ ok: false as const, cause }),
		);
		vi.restoreAllMocks();
		if (outcome.ok) catalogs.release(fixture.store, outcome.root);
		await fixture.store.idle();
		return { outcome, calls, before, after: usage(fixture.store), failures: fixture.store.status().failures };
	} finally {
		vi.restoreAllMocks();
		await fixture.close();
	}
}

it.each([
	["300 components", rows(300), 8],
	["one component over 12,000 leaves", wide(12_000), 4],
])(
	"X04 %s: failing leaf creation call N for every N the build makes, or the root read, leaves no leaf, owner or tree node behind",
	async (_label, components, minCalls) => {
		const clean = await attempt(components);
		expect(clean.outcome).toMatchObject({ ok: true });
		expect(clean.after).toEqual(clean.before);
		expect(clean.calls.createLeaf).toBeGreaterThanOrEqual(minCalls);
		const faults: Fault[] = Array.from({ length: clean.calls.createLeaf }, (_, n) => ({
			method: "createLeaf",
			at: n + 1,
		}));
		// The last read of a build is root()'s read of the sealed top node, after every level gave up its owners.
		faults.push({ method: "readLeaf", at: clean.calls.readLeaf });
		for (const fault of faults) {
			const run = await attempt(components, fault);
			const label = `${fault.method} call ${fault.at}`;
			expect(run.outcome, label).toMatchObject({ ok: false, cause: injected(fault.method) });
			expect(run.after, label).toEqual(run.before);
			expect(run.failures, label).toEqual([]);
		}
	},
);

it("X04 a component over 12,000 leaves is cataloged: its pointers span bounded side leaves, every stored leaf <= 64 KiB, and it reads back exactly", async () => {
	const fixture = await rig(wide(12_000));
	const created = vi.spyOn(fixture.store, "createLeaf");
	try {
		const catalogs = new CompactRecoveryCatalog();
		const root = await catalogs.build(fixture.store, catalogRootRef(2), fixture.components);
		fixture.drop();
		const sizes = created.mock.calls.map(([text]) => storedBytes(text).length);
		expect(sizes.length, "the pointer list spans several side leaves").toBeGreaterThan(2);
		expect(Math.max(...sizes)).toBeLessThanOrEqual(65_536);
		const read = await catalogs.read(fixture.store, root, childRef(root.ref, 0));
		expect(read.kind === "component" && read.text).toBe(wideText(12_000));
		await fixture.store.idle();
		expect(fixture.written.length, "the catalog leaves reached their files").toBeGreaterThan(0);
		expect(Math.max(...fixture.written)).toBeLessThanOrEqual(65_536);
		catalogs.release(fixture.store, root);
		await fixture.store.idle();
		expect(usage(fixture.store)).toEqual({ resident: 0, spilled: 0, pinned: 0, payload: 0, nodes: 0 });
	} finally {
		await fixture.close();
	}
});

const MISSING = 99_999;

/** Replaces the root's pointer head with a stored side leaf of `text` under its correct `pointer` digest. */
const withSide = (store: CompactContentStore, root: CatalogRoot, text: string): CatalogRoot => {
	const side = store.createLeaf(text);
	store.text.own([side]);
	store.adjust(side, -1, 0);
	return { ...root, side, sideDigest: catalogDigest("pointer", storedBytes(text)) };
};

it.each([
	["a node leaf", `{"n":${MISSING},"s":1,"d":"${"00".repeat(32)}"}`, 0],
	["a side (pointer) leaf", `{"s":${MISSING},"d":"${"00".repeat(32)}"}`, 1],
])(
	"RULING-58 (2) a stored pointer naming %s the store does not hold is corruption (integrity)",
	async (_label, token, height) => {
		const fixture = await rig(rows(3));
		try {
			const catalogs = new CompactRecoveryCatalog();
			const built = await catalogs.build(fixture.store, catalogRootRef(5), fixture.components);
			const root = withSide(fixture.store, built, `{"h":${height},"v":[${token}]}`);
			await expect(catalogs.read(fixture.store, root, childRef(root.ref, 0))).rejects.toMatchObject({
				name: "CompactReadError",
				reason: "integrity",
			});
			fixture.drop();
			catalogs.release(fixture.store, built);
		} finally {
			await fixture.close();
		}
	},
);

it("RULING-58 (2) a pointer naming a component leaf the store does not hold is corruption (integrity), never ownership; a released root stays ownership", async () => {
	const fixture = await rig(rows(3));
	try {
		const catalogs = new CompactRecoveryCatalog();
		const root = await catalogs.build(fixture.store, catalogRootRef(3), fixture.components);
		const original = fixture.store.readLeaf.bind(fixture.store);
		const [gone] = fixture.components[1]?.leaves ?? [];
		vi.spyOn(fixture.store, "readLeaf").mockImplementation(async (id) => {
			if (id === gone) throw new CompactReadError("ownership");
			return original(id);
		});
		await expect(catalogs.read(fixture.store, root, childRef(root.ref, 1))).rejects.toMatchObject({
			reason: "integrity",
		});
		vi.restoreAllMocks();
		fixture.drop();
		catalogs.release(fixture.store, root);
		await expect(catalogs.read(fixture.store, root, root.ref)).rejects.toMatchObject({ reason: "ownership" });
	} finally {
		await fixture.close();
	}
});

it("a node read returns exactly its public fields: no store id, owner or entry field", async () => {
	const fixture = await rig(rows(200));
	try {
		const catalogs = new CompactRecoveryCatalog();
		const root = await catalogs.build(fixture.store, catalogRootRef(4), fixture.components);
		fixture.drop();
		const keys = ["digest", "entries", "kind", "length", "ref"];
		expect(Object.keys(await catalogs.read(fixture.store, root, root.ref)).sort()).toEqual(keys);
		expect(Object.keys(await catalogs.read(fixture.store, root, childRef(root.ref, 1))).sort()).toEqual(keys);
		catalogs.release(fixture.store, root);
	} finally {
		await fixture.close();
	}
});
