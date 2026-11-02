import { CompactReadError } from "./compact-read-lease.ts";

export interface IndexNode<T> {
	readonly key: string;
	readonly value: T;
	readonly left: IndexNode<T> | undefined;
	readonly right: IndexNode<T> | undefined;
	readonly height: number;
	readonly size: number;
	live: number;
	pins: number;
}

/** Resident membership/path headers only; immutable values have their own spillable ownership. */
export class CompactIndexTree<T> {
	residentNodes = 0;
	allocatedNodes = 0;
	private readonly retain: (value: T, live: number, pins: number) => void;

	constructor(retain: (value: T, live: number, pins: number) => void) {
		this.retain = retain;
	}

	get(root: IndexNode<T> | undefined, key: string): T | undefined {
		let node = root;
		while (node) {
			if (key === node.key) return node.value;
			node = key < node.key ? node.left : node.right;
		}
		return undefined;
	}

	adjust(root: IndexNode<T> | undefined, live: number, pins: number): void {
		if (!root) return;
		const wasLive = Number(root.live > 0);
		const wasPinned = Number(root.live === 0 && root.pins > 0);
		if (root.live + live < 0 || root.pins + pins < 0) throw new CompactReadError("ownership");
		root.live += live;
		root.pins += pins;
		const l = Number(root.live > 0) - wasLive;
		const p = Number(root.live === 0 && root.pins > 0) - wasPinned;
		if (l || p) {
			this.retain(root.value, l, p);
			this.adjust(root.left, l, p);
			this.adjust(root.right, l, p);
		}
		if (root.live === 0 && root.pins === 0) this.residentNodes--;
	}

	set(root: IndexNode<T> | undefined, key: string, value: T | undefined): IndexNode<T> | undefined {
		if (!root) return value === undefined ? undefined : this.make(key, value, undefined, undefined);
		if (key === root.key) {
			if (value !== undefined) return this.make(key, value, root.left, root.right);
			if (!root.left || !root.right) {
				const child = root.left ?? root.right;
				this.adjust(child, 1, 0);
				return child;
			}
			let next = root.right;
			while (next.left) next = next.left;
			const right = this.set(root.right, next.key, undefined);
			const result = this.balance(next.key, next.value, root.left, right);
			this.adjust(right, -1, 0);
			return result;
		}
		const leftward = key < root.key;
		const child = this.set(leftward ? root.left : root.right, key, value);
		const result = this.balance(root.key, root.value, leftward ? child : root.left, leftward ? root.right : child);
		this.adjust(child, -1, 0);
		return result;
	}

	*entries(root: IndexNode<T> | undefined, after?: string): IterableIterator<readonly [string, T]> {
		if (!root) return;
		if (after === undefined || root.key > after) {
			yield* this.entries(root.left, after);
			yield [root.key, root.value];
		}
		yield* this.entries(root.right, after);
	}

	private make(key: string, value: T, left: IndexNode<T> | undefined, right: IndexNode<T> | undefined): IndexNode<T> {
		this.adjust(left, 1, 0);
		this.adjust(right, 1, 0);
		this.retain(value, 1, 0);
		this.residentNodes++;
		this.allocatedNodes++;
		return {
			key,
			value,
			left,
			right,
			live: 1,
			pins: 0,
			height: 1 + Math.max(left?.height ?? 0, right?.height ?? 0),
			size: 1 + (left?.size ?? 0) + (right?.size ?? 0),
		};
	}

	private balance(
		key: string,
		value: T,
		left: IndexNode<T> | undefined,
		right: IndexNode<T> | undefined,
	): IndexNode<T> {
		if (left && left.height > (right?.height ?? 0) + 1) {
			const middle = left.right;
			if (middle && middle.height > (left.left?.height ?? 0)) {
				const a = this.make(left.key, left.value, left.left, middle.left);
				const b = this.make(key, value, middle.right, right);
				const result = this.make(middle.key, middle.value, a, b);
				this.adjust(a, -1, 0);
				this.adjust(b, -1, 0);
				return result;
			}
			const b = this.make(key, value, left.right, right);
			const result = this.make(left.key, left.value, left.left, b);
			this.adjust(b, -1, 0);
			return result;
		}
		if (right && right.height > (left?.height ?? 0) + 1) {
			const middle = right.left;
			if (middle && middle.height > (right.right?.height ?? 0)) {
				const a = this.make(key, value, left, middle.left);
				const b = this.make(right.key, right.value, middle.right, right.right);
				const result = this.make(middle.key, middle.value, a, b);
				this.adjust(a, -1, 0);
				this.adjust(b, -1, 0);
				return result;
			}
			const a = this.make(key, value, left, right.left);
			const result = this.make(right.key, right.value, a, right.right);
			this.adjust(a, -1, 0);
			return result;
		}
		return this.make(key, value, left, right);
	}
}
