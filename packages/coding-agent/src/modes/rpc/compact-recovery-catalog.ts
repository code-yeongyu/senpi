import {
	type CatalogEntry,
	CatalogNodeWriter,
	catalogDigest,
	catalogDigester,
	decodeCatalogNode,
	storedBytes,
} from "./compact-catalog-codec.ts";
import { CatalogPointerWriter, catalogPointer, type PointerHead } from "./compact-catalog-pointers.ts";
import type { CompactContentStore, LeafId } from "./compact-content-store.ts";
import { CompactReadError } from "./compact-read-lease.ts";
import { childRef, type ContentDigest, type ContentRef, protocolId, refSteps } from "./compact-recovery-ids.ts";

/** One component as a family adapter yields it: its stored leaves in order and the owner that keeps them pinned. */
export interface CatalogComponent {
	readonly kind: CatalogEntry["kind"];
	readonly id: CatalogEntry["id"];
	readonly leaves: readonly LeafId[];
	readonly owner: LeafId;
}

/** A built catalog: the root node, the head of its private pointer leaves and the one owner of the whole tree. */
export interface CatalogRoot {
	readonly ref: ContentRef;
	readonly node: LeafId;
	readonly side: LeafId;
	readonly sideDigest: ContentDigest;
	readonly owner: LeafId;
	readonly digest: ContentDigest;
	readonly length: number;
	readonly depth: number;
	readonly components: number;
	readonly nodes: number;
}

export type CatalogRead =
	| {
			readonly kind: "node";
			readonly ref: ContentRef;
			readonly entries: readonly CatalogEntry[];
			readonly digest: ContentDigest;
			readonly length: number;
	  }
	| { readonly kind: "component"; readonly ref: ContentRef; readonly entry: CatalogEntry; readonly text: string };

/** One open node per level: its entries, its pointer leaves so far, and the owners the sealed node will share. */
interface Level {
	readonly writer: CatalogNodeWriter;
	readonly pointers: CatalogPointerWriter;
	readonly sides: LeafId[];
	readonly owners: LeafId[];
}
interface Sealed {
	readonly entry: CatalogEntry;
	readonly node: LeafId;
	readonly head: PointerHead;
	readonly owner: LeafId;
}
type Child = { readonly leaves: readonly LeafId[] } | Pick<Sealed, "node" | "head">;

const NODE = protocolId("node");

/**
 * Builds and reads immutable catalog trees (R4.B1): nodes are packed bottom-up as components stream in, so at most
 * one open node per level is resident and no collection of every component exists. Every node is one store leaf
 * plus its pointer leaves, under one owner that shares the pinned content it describes; releasing the root owner
 * releases the tree. Level 0 owners stay the caller's. Every reference the build itself takes (a node or pointer
 * leaf, a sealed node's owner) is in `held` from the call that creates it until a parent owner takes it over, so a
 * failure at any point, the root read included, releases all of them and reports no root.
 */
export class CompactRecoveryCatalog {
	private buffered = 0;
	/** The most descriptors resident at once across builds; a test instrument for the X04 working-set bound. */
	peakBuffered = 0;

	async build(
		store: CompactContentStore,
		ref: ContentRef,
		components: Iterable<CatalogComponent> | AsyncIterable<CatalogComponent>,
		valid: () => void = () => undefined,
	): Promise<CatalogRoot> {
		const held = new Set<LeafId>();
		const transfer = (id: LeafId): void => {
			store.adjust(id, -1, 0);
			held.delete(id);
		};
		const newLevel = (): Level => {
			const sides: LeafId[] = [];
			const pointers = new CatalogPointerWriter((text) => {
				const side = store.createLeaf(text, true);
				held.add(side);
				sides.push(side);
				return side;
			});
			return { writer: new CatalogNodeWriter(), pointers, sides, owners: [] };
		};
		const levels: Level[] = [];
		const at = (level: number): Level => levels[level] ?? (levels[level] = newLevel());
		let count = 0;
		let nodes = 0;
		const seal = (level: number): Sealed => {
			const sealed = at(level);
			const text = sealed.writer.encode();
			const node = store.createLeaf(text, true);
			held.add(node);
			const head = sealed.pointers.finish();
			const owner = store.text.own([node, ...sealed.sides, ...sealed.owners]);
			held.add(owner);
			for (const taken of level > 0 ? [node, ...sealed.sides, ...sealed.owners] : [node, ...sealed.sides])
				transfer(taken);
			levels[level] = newLevel();
			this.buffered -= sealed.writer.count;
			const bytes = storedBytes(text);
			const id = protocolId(`node-${String(++nodes).padStart(16, "0")}`);
			return {
				entry: { kind: NODE, id, length: bytes.length, digest: catalogDigest("node", bytes) },
				node,
				head,
				owner,
			};
		};
		const place = (level: number, entry: CatalogEntry, child: Child, owner: LeafId): void => {
			if (!at(level).writer.push(entry)) {
				const sealed = seal(level);
				place(level + 1, sealed.entry, sealed, sealed.owner);
				if (!at(level).writer.push(entry)) throw new CompactReadError("size_limit");
			}
			this.peakBuffered = Math.max(this.peakBuffered, ++this.buffered);
			const open = at(level);
			open.owners.push(owner);
			if ("leaves" in child) open.pointers.component(child.leaves);
			else open.pointers.node(child.node, child.head);
		};
		try {
			for await (const component of components) {
				place(0, await this.describe(store, component, valid), component, component.owner);
				count += 1;
			}
			for (let level = 0; ; level++) {
				at(level);
				const top = level === levels.length - 1;
				const sealed = seal(level);
				if (!top) {
					place(level + 1, sealed.entry, sealed, sealed.owner);
					continue;
				}
				const root = await this.root(store, ref, sealed, level + 1, count, nodes);
				held.delete(root.owner);
				return root;
			}
		} catch (cause) {
			for (const { writer } of levels) this.buffered -= writer.count;
			for (const id of held) store.adjust(id, -1, 0);
			throw cause;
		}
	}

	/** Verifies the stored bytes of every node on the path against its parent's digest before decoding it. */
	async read(store: CompactContentStore, root: CatalogRoot, ref: ContentRef): Promise<CatalogRead> {
		if (ref !== root.ref && !ref.startsWith(`${root.ref}:`)) throw new CompactReadError("range");
		const steps = refSteps(ref);
		let node = root.node;
		let head: PointerHead = { side: root.side, digest: root.sideDigest };
		let expected: Pick<CatalogEntry, "length" | "digest"> = root;
		let here = root.ref;
		for (let depth = 0; ; depth++) {
			// The root node is named by the caller's root, so a released root stays `ownership`.
			const text = depth === 0 ? await store.readLeaf(node) : await this.stored(store, node);
			if (catalogDigest(depth === 0 ? "root" : "node", storedBytes(text)) !== expected.digest)
				throw new CompactReadError("integrity");
			const decoded = decodeCatalogNode(text);
			if (!decoded.ok) throw new CompactReadError("integrity");
			const step = steps[depth];
			if (step === undefined)
				return {
					kind: "node",
					ref: here,
					entries: decoded.entries,
					digest: expected.digest,
					length: expected.length,
				};
			const entry = decoded.entries[step];
			if (!entry) throw new CompactReadError("range");
			const pointer = await catalogPointer((side) => this.stored(store, side), head, step);
			if (!pointer) throw new CompactReadError("integrity");
			here = childRef(here, step);
			if (pointer.kind === "component") {
				if (depth + 1 !== steps.length) throw new CompactReadError("range");
				return { kind: "component", ref: here, entry, text: await this.verify(store, entry, pointer.leaves) };
			}
			node = pointer.node;
			head = pointer.head;
			expected = entry;
		}
	}

	release(store: CompactContentStore, root: CatalogRoot): void {
		store.adjust(root.owner, -1, 0);
	}

	/** Reads a leaf a stored pointer names: the tree owner keeps it alive, so a missing one is corruption. */
	private async stored(store: CompactContentStore, id: LeafId): Promise<string> {
		try {
			return await store.readLeaf(id);
		} catch (cause) {
			if (cause instanceof CompactReadError && cause.reason === "ownership") throw new CompactReadError("integrity");
			throw cause;
		}
	}

	private async describe(
		store: CompactContentStore,
		component: CatalogComponent,
		valid: () => void,
	): Promise<CatalogEntry> {
		const length = component.leaves.reduce((sum, leaf) => sum + store.leafUnits(leaf) * 2, 0);
		const digester = catalogDigester("leaf", length);
		for (const leaf of component.leaves) {
			digester.update(storedBytes(await store.readLeaf(leaf)));
			valid();
		}
		return { kind: component.kind, id: component.id, length, digest: digester.finish() };
	}

	private async verify(store: CompactContentStore, entry: CatalogEntry, leaves: readonly LeafId[]): Promise<string> {
		const digester = catalogDigester("leaf", entry.length);
		const chunks: string[] = [];
		let fed = 0;
		for (const leaf of leaves) {
			const text = await this.stored(store, leaf);
			fed += text.length * 2;
			if (fed > entry.length) throw new CompactReadError("integrity");
			digester.update(storedBytes(text));
			chunks.push(text);
		}
		if (fed !== entry.length || digester.finish() !== entry.digest) throw new CompactReadError("integrity");
		return chunks.join("");
	}

	private async root(
		store: CompactContentStore,
		ref: ContentRef,
		{ node, head, owner }: Sealed,
		depth: number,
		components: number,
		nodes: number,
	): Promise<CatalogRoot> {
		const bytes = storedBytes(await store.readLeaf(node));
		const digest = catalogDigest("root", bytes);
		return {
			ref,
			node,
			side: head.side,
			sideDigest: head.digest,
			owner,
			digest,
			length: bytes.length,
			depth,
			components,
			nodes,
		};
	}
}
