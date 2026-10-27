import { z } from "zod";
import {
	type CatalogEntry,
	CatalogNodeWriter,
	catalogDigest,
	catalogDigester,
	decodeCatalogNode,
	storedBytes,
} from "./compact-catalog-codec.ts";
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

/** A built catalog: the root node, its private pointer leaf and the one owner that releases the whole tree. */
export interface CatalogRoot {
	readonly ref: ContentRef;
	readonly node: LeafId;
	readonly side: LeafId;
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

/** Where a child lives in the store: a node with its pointer leaf, or a component's leaves. Never hashed or sent. */
const PointerSchema = z.union([
	z.object({ n: z.number().int().positive(), s: z.number().int().positive() }).strict(),
	z.object({ l: z.array(z.number().int().positive()) }).strict(),
]);
type Pointer = z.infer<typeof PointerSchema>;
type NodePointer = Extract<Pointer, { readonly n: number }>;
const PointersSchema = z.array(PointerSchema);

/** One open node per level: its entries, their pointers, and the owners the sealed node will share. */
interface Level {
	readonly writer: CatalogNodeWriter;
	readonly pointers: Pointer[];
	readonly owners: LeafId[];
}
interface Sealed {
	readonly entry: CatalogEntry;
	readonly pointer: NodePointer;
	readonly owner: LeafId;
}

const NODE = protocolId("node");
const newLevel = (): Level => ({ writer: new CatalogNodeWriter(), pointers: [], owners: [] });

/**
 * Builds and reads immutable catalog trees (R4.B1): nodes are packed bottom-up as components stream in, so at most
 * one open node per level is resident and no collection of every component exists. Every node is one store leaf
 * whose owner shares the pinned content it describes; releasing the root owner releases the tree. Level 0 owners
 * belong to the frozen root; a sealed node's owner is this builder's until its parent seals or the build fails.
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
		const levels: Level[] = [];
		const at = (level: number): Level => levels[level] ?? (levels[level] = newLevel());
		let count = 0;
		let nodes = 0;
		const seal = (level: number): Sealed => {
			const sealed = at(level);
			levels[level] = newLevel();
			const text = sealed.writer.encode();
			const node = store.createLeaf(text, true);
			const side = store.createLeaf(JSON.stringify(sealed.pointers), true);
			const owner = store.text.own([node, side, ...sealed.owners]);
			for (const held of level > 0 ? [node, side, ...sealed.owners] : [node, side]) store.adjust(held, -1, 0);
			this.buffered -= sealed.writer.count;
			const bytes = storedBytes(text);
			const id = protocolId(`node-${String(++nodes).padStart(16, "0")}`);
			const entry = { kind: NODE, id, length: bytes.length, digest: catalogDigest("node", bytes) };
			return { entry, pointer: { n: node, s: side }, owner };
		};
		const place = (level: number, entry: CatalogEntry, pointer: Pointer, owner: LeafId): void => {
			if (!at(level).writer.push(entry)) {
				const sealed = seal(level);
				place(level + 1, sealed.entry, sealed.pointer, sealed.owner);
				if (!at(level).writer.push(entry)) throw new CompactReadError("size_limit");
			}
			at(level).pointers.push(pointer);
			at(level).owners.push(owner);
			this.peakBuffered = Math.max(this.peakBuffered, ++this.buffered);
		};
		try {
			for await (const component of components) {
				const entry = await this.describe(store, component, valid);
				place(0, entry, { l: [...component.leaves] }, component.owner);
				count += 1;
			}
			for (let level = 0; ; level++) {
				at(level);
				const top = level === levels.length - 1;
				const sealed = seal(level);
				if (top) return this.root(store, ref, sealed, level + 1, count, nodes);
				place(level + 1, sealed.entry, sealed.pointer, sealed.owner);
			}
		} catch (cause) {
			for (const [level, { owners, writer }] of levels.entries()) {
				if (level > 0) for (const owner of owners) store.adjust(owner, -1, 0);
				this.buffered -= writer.count;
			}
			throw cause;
		}
	}

	/** Verifies the stored bytes of every node on the path against its parent's digest before decoding it. */
	async read(store: CompactContentStore, root: CatalogRoot, ref: ContentRef): Promise<CatalogRead> {
		if (ref !== root.ref && !ref.startsWith(`${root.ref}:`)) throw new CompactReadError("range");
		const steps = refSteps(ref);
		let node = root.node;
		let side = root.side;
		let expected: Pick<CatalogEntry, "length" | "digest"> = root;
		let here = root.ref;
		for (let depth = 0; ; depth++) {
			const text = await store.readLeaf(node);
			if (catalogDigest(depth === 0 ? "root" : "node", storedBytes(text)) !== expected.digest)
				throw new CompactReadError("integrity");
			const decoded = decodeCatalogNode(text);
			if (!decoded.ok) throw new CompactReadError("integrity");
			const step = steps[depth];
			if (step === undefined) return { kind: "node", ref: here, entries: decoded.entries, ...expected };
			const entry = decoded.entries[step];
			// The pointer leaf carries no digest of its own: it only says where the child's bytes are, and those bytes are
			// verified against this parent's entry before any use, so a wrong or stale pointer surfaces as `integrity`.
			const pointer = this.pointer(await store.readLeaf(side), step);
			if (!entry || !pointer) throw new CompactReadError("range");
			here = childRef(here, step);
			if ("l" in pointer) {
				if (depth + 1 !== steps.length) throw new CompactReadError("range");
				return { kind: "component", ref: here, entry, text: await this.verify(store, entry, pointer.l) };
			}
			node = pointer.n;
			side = pointer.s;
			expected = entry;
		}
	}

	release(store: CompactContentStore, root: CatalogRoot): void {
		store.adjust(root.owner, -1, 0);
	}

	/** A pointer leaf that is not a pointer list is corruption of this store's private bytes, never a bad ref. */
	private pointer(text: string, step: number): Pointer | undefined {
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch (cause) {
			if (cause instanceof SyntaxError) throw new CompactReadError("integrity");
			throw cause;
		}
		const pointers = PointersSchema.safeParse(json);
		if (!pointers.success) throw new CompactReadError("integrity");
		return pointers.data[step];
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
			const text = await store.readLeaf(leaf);
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
		{ pointer, owner }: Sealed,
		depth: number,
		components: number,
		nodes: number,
	): Promise<CatalogRoot> {
		const bytes = storedBytes(await store.readLeaf(pointer.n));
		const digest = catalogDigest("root", bytes);
		return { ref, node: pointer.n, side: pointer.s, owner, digest, length: bytes.length, depth, components, nodes };
	}
}
