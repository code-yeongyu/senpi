import { CompactCommitDependencies } from "./compact-commit-dependencies.ts";
import { COMPACT_LEAF_CODE_UNITS, type CompactContentStore, type LeafId } from "./compact-content-store.ts";
import { CompactReadError } from "./compact-read-lease.ts";

interface Node {
	readonly left: LeafId;
	readonly right: LeafId;
	readonly units: number;
	readonly height: number;
	live: number;
	pins: number;
}

/** Persistent append tree: positive refs are leaves, negative refs are nodes, zero is empty. */
export class CompactTextRoots {
	private readonly nodes = new Map<LeafId, Node>();
	private readonly pending: CompactCommitDependencies<LeafId>;
	private readonly store: CompactContentStore;
	private next = -1;

	constructor(store: CompactContentStore) {
		this.store = store;
		this.pending = new CompactCommitDependencies(store, (id) => store.committed(id));
	}

	get residentNodes(): number {
		return this.nodes.size;
	}

	units(id: LeafId): number {
		return id === 0 ? 0 : id > 0 ? this.store.leafUnits(id) : this.node(id).units;
	}

	isCommitted(id: LeafId): boolean {
		return this.nodes.has(id) && !this.pending.has(id);
	}

	/** Transfers one live root and one newly owned bounded leaf into the new root. */
	append(root: LeafId, text: string): LeafId {
		this.units(root);
		const leaf = this.store.createLeaf(text);
		if (root === 0) return leaf;
		const result = this.appendLeaf(root, leaf);
		this.store.adjust(root, -1, 0);
		this.store.adjust(leaf, -1, 0);
		return result;
	}

	adjust(id: LeafId, live: number, pins: number): void {
		const node = this.node(id);
		const beforeLive = Number(node.live > 0);
		const beforePin = Number(node.live === 0 && node.pins > 0);
		if (node.live + live < 0 || node.pins + pins < 0) throw new CompactReadError("ownership");
		node.live += live;
		node.pins += pins;
		const liveChange = Number(node.live > 0) - beforeLive;
		const pinChange = Number(node.live === 0 && node.pins > 0) - beforePin;
		// Extra cuts on a live subtree do not visit children. Only category transitions propagate.
		if (liveChange || pinChange) {
			this.store.adjust(node.left, liveChange, pinChange);
			this.store.adjust(node.right, liveChange, pinChange);
		}
		if (node.live === 0 && node.pins === 0) {
			this.pending.delete(id);
			this.nodes.delete(id);
		}
	}

	/** Bounded UTF-16 result and bounded leaf/tail count, checked before any I/O. */
	async read(
		root: LeafId,
		tail: string,
		offset: number,
		units: number,
		maxLeaves = 2,
		valid: () => void = () => this.store.assertReadable(),
	): Promise<string> {
		this.store.assertReadable();
		valid();
		const length = this.units(root);
		if (
			!Number.isSafeInteger(offset) ||
			!Number.isSafeInteger(units) ||
			offset < 0 ||
			units < 0 ||
			offset + units > length + tail.length
		)
			throw new CompactReadError("range");
		if (units > COMPACT_LEAF_CODE_UNITS) throw new CompactReadError("size_limit");
		if (!Number.isSafeInteger(maxLeaves) || maxLeaves < 1 || maxLeaves > 2) throw new CompactReadError("count_limit");
		const selected: { id: LeafId; offset: number; units: number }[] = [];
		const visit = (id: LeafId, start: number, end: number): void => {
			if (start >= end || id === 0) return;
			if (id > 0) {
				if (selected.length === maxLeaves) throw new CompactReadError("count_limit");
				selected.push({ id, offset: start, units: end - start });
			} else {
				const node = this.node(id);
				const leftUnits = this.units(node.left);
				visit(node.left, start, Math.min(end, leftUnits));
				visit(node.right, Math.max(0, start - leftUnits), end - leftUnits);
			}
		};
		visit(root, offset, Math.min(length, offset + units));
		const tailUnits = units === 0 ? 0 : Math.max(0, offset + units - Math.max(offset, length));
		if (selected.length + Number(tailUnits > 0) > maxLeaves) throw new CompactReadError("count_limit");
		this.store.adjust(root, 0, 1);
		const done = this.store.beginRead();
		try {
			let result = "";
			for (const part of selected) {
				const text = await this.store.readLeaf(part.id);
				valid();
				result += text.slice(part.offset, part.offset + part.units);
			}
			valid();
			return result + tail.slice(Math.max(0, offset - length), Math.max(0, offset - length) + tailUnits);
		} finally {
			this.store.adjust(root, 0, -1);
			done();
		}
	}

	private node(id: LeafId): Node {
		const node = this.nodes.get(id);
		if (!node) throw new CompactReadError("ownership");
		return node;
	}

	private appendLeaf(root: LeafId, leaf: LeafId): LeafId {
		const node = this.nodes.get(root);
		if (!node || this.height(node.left) === this.height(node.right)) return this.join(root, leaf);
		const right = this.appendLeaf(node.right, leaf);
		const result = this.join(node.left, right);
		this.store.adjust(right, -1, 0);
		return result;
	}

	private height(id: LeafId): number {
		return id > 0 ? 0 : this.node(id).height;
	}

	private join(left: LeafId, right: LeafId): LeafId {
		const id = this.next--;
		this.nodes.set(id, {
			left,
			right,
			units: this.units(left) + this.units(right),
			height: 1 + Math.max(this.height(left), this.height(right)),
			live: 1,
			pins: 0,
		});
		this.store.adjust(left, 1, 0);
		this.store.adjust(right, 1, 0);
		this.pending.set(id, [left, right]);
		return id;
	}
}
