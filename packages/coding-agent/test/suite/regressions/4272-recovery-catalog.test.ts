import { afterEach, expect, it, vi } from "vitest";
import { catalogDigest, storedBytes } from "../../../src/modes/rpc/compact-catalog-codec.ts";
import { CompactContentStore, CompactWriteError } from "../../../src/modes/rpc/compact-content-store.ts";
import { CompactReadError } from "../../../src/modes/rpc/compact-read-lease.ts";
import {
	type CatalogComponent,
	type CatalogRoot,
	CompactRecoveryCatalog,
} from "../../../src/modes/rpc/compact-recovery-catalog.ts";
import { catalogRootRef, childRef, type ContentRef, protocolId } from "../../../src/modes/rpc/compact-recovery-ids.ts";
import { controlledIo, spoolRoot } from "../compact-storage-support.ts";

// Part of #4272 (S09, R4.B1, X03/X04): the catalog is an immutable tree of bounded nodes built bottom-up from a frozen
// root with a bounded working set; every component is reachable without a root array of all descriptors, and no
// completed root is reported from an incomplete tree.

afterEach(() => {
	vi.restoreAllMocks();
});

async function rig(count: number, text = (n: number) => `component-${n}`) {
	const root = await spoolRoot();
	const control = controlledIo();
	const store = new CompactContentStore({ dir: root.dir, io: control.io });
	const texts = Array.from({ length: count }, (_, n) => text(n));
	const components: CatalogComponent[] = texts.map((body, n) => {
		const leaf = store.createLeaf(body, true);
		return {
			kind: protocolId("row"),
			id: protocolId(`row-${String(n).padStart(16, "0")}`),
			leaves: [leaf],
			owner: leaf,
		};
	});
	const drop = () => {
		for (const { owner } of components) store.adjust(owner, -1, 0);
	};
	return {
		store,
		control,
		texts,
		components,
		drop,
		async close() {
			await store.retire();
			await root.cleanup();
		},
	};
}

/** Every node and component reachable from the root through verified reads; at most one node resident per level. */
async function walk(catalogs: CompactRecoveryCatalog, store: CompactContentStore, root: CatalogRoot) {
	const seen = { nodes: 0, components: 0, maxEntries: 0, maxLength: 0, texts: new Map<string, string>() };
	const visit = async (ref: ContentRef): Promise<void> => {
		const read = await catalogs.read(store, root, ref);
		if (read.kind === "component") {
			seen.components++;
			seen.texts.set(read.entry.id, read.text);
			return;
		}
		seen.nodes++;
		seen.maxEntries = Math.max(seen.maxEntries, read.entries.length);
		seen.maxLength = Math.max(seen.maxLength, read.length);
		for (const [index] of read.entries.entries()) await visit(childRef(ref, index));
	};
	await visit(root.ref);
	return seen;
}

it.each([
	[0, 1],
	[128, 1],
	[129, 2],
	[5_000, 2],
])(
	"X03 X04 a catalog of %i components has depth %i, every node <= 128 entries and <= 64 KiB, and a working set bounded by depth",
	async (count, depth) => {
		const catalogs = new CompactRecoveryCatalog();
		const fixture = await rig(count);
		try {
			const root = await catalogs.build(fixture.store, catalogRootRef(1), fixture.components);
			fixture.drop();
			expect(root).toMatchObject({ ref: "c-0000000000000001", depth, components: count });
			expect(root.nodes).toBe(count === 0 ? 1 : Math.ceil(count / 128) + (depth > 1 ? 1 : 0));
			expect(catalogs.peakBuffered, "resident descriptors never exceed one node per level").toBeLessThanOrEqual(
				128 * depth,
			);
			const seen = await walk(catalogs, fixture.store, root);
			expect(seen).toMatchObject({ nodes: root.nodes, components: count });
			expect(seen.maxEntries).toBeLessThanOrEqual(128);
			expect(seen.maxLength).toBeLessThanOrEqual(65_536);
			expect(root.length).toBeLessThanOrEqual(seen.maxLength);
			for (const [n, text] of fixture.texts.entries())
				expect(seen.texts.get(`row-${String(n).padStart(16, "0")}`)).toBe(text);
			catalogs.release(fixture.store, root);
			await fixture.store.idle();
			expect(fixture.store.status().structuredBytes).toEqual({ resident: 0, spilled: 0, pinned: 0 });
			expect(fixture.store.text.residentNodes).toBe(0);
		} finally {
			await fixture.close();
		}
	},
);

it("X04 wide descriptors fill the node byte boundary before the 128th entry; the encoder never retains an over-budget node", async () => {
	const catalogs = new CompactRecoveryCatalog();
	const fixture = await rig(300);
	const wide = fixture.components.map((component, n) => ({
		...component,
		kind: protocolId("k".repeat(128)),
		id: protocolId(`${"i".repeat(111)}${String(n).padStart(16, "0")}`),
	}));
	const created = vi.spyOn(fixture.store, "createLeaf");
	try {
		const root = await catalogs.build(fixture.store, catalogRootRef(2), wide);
		fixture.drop();
		expect(root.nodes).toBeGreaterThan(Math.ceil(300 / 128) + 1);
		for (const [text] of created.mock.calls) expect(text.length).toBeLessThanOrEqual(32_768);
		const seen = await walk(catalogs, fixture.store, root);
		expect(seen.components).toBe(300);
		expect(seen.maxEntries).toBeLessThan(128);
		expect(seen.maxLength).toBeLessThanOrEqual(65_536);
		catalogs.release(fixture.store, root);
	} finally {
		await fixture.close();
	}
});

it("S09-Q1 digests are independent of storage numbering and host: two stores with different leaf ids give identical root and node digests", async () => {
	const catalogs = new CompactRecoveryCatalog();
	const first = await rig(200);
	const second = await rig(0);
	try {
		second.store.createLeaf("shifts every later leaf id", true);
		const components = first.texts.map((body, n) => {
			const leaf = second.store.createLeaf(body, true);
			return { ...first.components[n], leaves: [leaf], owner: leaf };
		});
		const rootA = await catalogs.build(first.store, catalogRootRef(3), first.components);
		const rootB = await catalogs.build(second.store, catalogRootRef(3), components);
		expect(rootB.digest).toBe(rootA.digest);
		expect(rootB.length).toBe(rootA.length);
		const nodeA = await catalogs.read(first.store, rootA, childRef(rootA.ref, 1));
		const nodeB = await catalogs.read(second.store, rootB, childRef(rootB.ref, 1));
		expect(nodeB).toEqual(nodeA);
		const leaf = await catalogs.read(first.store, rootA, childRef(childRef(rootA.ref, 0), 7));
		expect(leaf.kind === "component" && leaf.entry.digest).toBe(catalogDigest("leaf", storedBytes("component-7")));
		catalogs.release(first.store, rootA);
		catalogs.release(second.store, rootB);
	} finally {
		await first.close();
		await second.close();
	}
});

it.each([
	[
		"a child released before the build",
		(fixture: Awaited<ReturnType<typeof rig>>) => fixture.drop(),
		CompactReadError,
	],
	[
		"a storage failure while a node is written",
		(fixture: Awaited<ReturnType<typeof rig>>) => {
			const original = fixture.store.createLeaf.bind(fixture.store);
			let calls = 0;
			vi.spyOn(fixture.store, "createLeaf").mockImplementation((text, value) => {
				if (++calls === 3) throw new CompactWriteError("storage_unavailable");
				return original(text, value);
			});
		},
		CompactWriteError,
	],
])(
	"X04 %s: no root or digest is reported and every construction owner is released",
	async (_label, sabotage, error) => {
		const catalogs = new CompactRecoveryCatalog();
		const fixture = await rig(300);
		try {
			sabotage(fixture);
			await fixture.store.idle();
			const before = fixture.store.status().structuredBytes;
			await expect(catalogs.build(fixture.store, catalogRootRef(4), fixture.components)).rejects.toBeInstanceOf(
				error,
			);
			vi.restoreAllMocks();
			await fixture.store.idle();
			expect(fixture.store.status().structuredBytes).toEqual(before);
			expect(fixture.store.status().failures).toEqual([]);
		} finally {
			await fixture.close();
		}
	},
);

it("T5 X04 a cut retired while the first catalog read is held publishes nothing and releases construction owners", async () => {
	const catalogs = new CompactRecoveryCatalog();
	const fixture = await rig(130);
	try {
		await fixture.store.idle();
		const before = fixture.store.status().structuredBytes;
		const held = fixture.control.hold("read");
		let retired = false;
		const valid = () => {
			if (retired) throw new CompactReadError("released");
		};
		const build = catalogs.build(fixture.store, catalogRootRef(5), fixture.components, valid);
		await held.entered;
		retired = true;
		held.release();
		await expect(build).rejects.toMatchObject({ reason: "released" });
		await fixture.store.idle();
		expect(fixture.store.status().structuredBytes).toEqual(before);
	} finally {
		await fixture.close();
	}
});

it("RULING-57 Q1 (3) a node whose stored bytes changed is refused as integrity before any decode: a flipped digit and a truncation both", async () => {
	const catalogs = new CompactRecoveryCatalog();
	const fixture = await rig(3);
	try {
		const root = await catalogs.build(fixture.store, catalogRootRef(6), fixture.components);
		fixture.drop();
		const original = fixture.store.readLeaf.bind(fixture.store);
		for (const corrupt of [
			(text: string) => text.replace('"length":', '"length":1'),
			(text: string) => text.slice(0, -4),
		]) {
			vi.spyOn(fixture.store, "readLeaf").mockImplementationOnce(async (id) => corrupt(await original(id)));
			await expect(catalogs.read(fixture.store, root, root.ref)).rejects.toMatchObject({
				name: "CompactReadError",
				reason: "integrity",
			});
		}
		vi.restoreAllMocks();
		const node = await catalogs.read(fixture.store, root, root.ref);
		expect(node.kind === "node" && node.entries.length).toBe(3);
		await expect(catalogs.read(fixture.store, root, childRef(root.ref, 3))).rejects.toMatchObject({
			reason: "range",
		});
		await expect(catalogs.read(fixture.store, root, catalogRootRef(7))).rejects.toMatchObject({ reason: "range" });
		catalogs.release(fixture.store, root);
	} finally {
		await fixture.close();
	}
});
