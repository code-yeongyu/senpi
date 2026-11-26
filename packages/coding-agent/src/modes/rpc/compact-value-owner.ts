import { type CompactContentStore, type LeafId, CompactWriteError } from "./compact-content-store.ts";
import type { ValuePage, ValueRef } from "./compact-values.ts";

/** Per-step owned limits (S03b-4, S10-Q2): one page holds at most this many descriptors or string code units. */
const VALUE_PAGE_ITEMS = 128;
const VALUE_PAGE_CODE_UNITS = 4096;
const INLINE_JSON_LENGTH = 64;

type Child = readonly [unknown, unknown] | unknown;
interface Frame {
	readonly object: object;
	readonly array: boolean;
	readonly entries: readonly Child[];
	/** The slice `[max(0, end - VALUE_PAGE_ITEMS), end)` is being owned; pages chain from the last slice to the first. */
	end: number;
	/** Each child of the slice in order; an object slice alternates key, value. */
	children: readonly unknown[];
	index: number;
	refs: ValueRef[];
	next: ValueRef | undefined;
}

const scalar = (value: unknown): value is number | boolean | null =>
	value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));

const plain = (value: unknown): value is object =>
	typeof value === "object" &&
	value !== null &&
	(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/**
 * Owns one JSON-normal value as chained bounded pages without recursion or an aggregate size, depth or node cap:
 * memory per step is one page plus the open containers' slices. A cycle or a non-JSON value is refused typed, and
 * every page already made is released again.
 */
export function ownValue(store: CompactContentStore, make: (page: ValuePage) => ValueRef, value: unknown): ValueRef {
	const owned = new Set<LeafId>();
	const ancestors = new Set<object>();
	const stack: Frame[] = [];
	const take = (page: ValuePage, children: readonly ValueRef[]): ValueRef => {
		const ref = make(page);
		owned.add(ref.owner);
		for (const child of children) {
			store.adjust(child.owner, -1, 0);
			owned.delete(child.owner);
		}
		return ref;
	};
	const ownString = (text: string): ValueRef => {
		let next: ValueRef | undefined;
		for (let end = text.length; end > 0; end = Math.max(0, end - VALUE_PAGE_CODE_UNITS))
			next = take(
				{ kind: "string", text: text.slice(Math.max(0, end - VALUE_PAGE_CODE_UNITS), end), next },
				next ? [next] : [],
			);
		if (!next) throw new CompactWriteError("unsupported_value");
		return next;
	};
	const open = (object: object): void => {
		if (ancestors.has(object)) throw new CompactWriteError("cycle");
		ancestors.add(object);
		const array = Array.isArray(object);
		const entries: readonly Child[] = array ? object : Object.entries(object);
		stack.push({ object, array, entries, end: entries.length, children: [], index: 0, refs: [], next: undefined });
		slice(stack[stack.length - 1]);
	};
	const slice = (frame: Frame): void => {
		const part = frame.entries.slice(Math.max(0, frame.end - VALUE_PAGE_ITEMS), frame.end);
		frame.children = frame.array ? part : (part as readonly (readonly [unknown, unknown])[]).flat();
		frame.index = 0;
		frame.refs = [];
	};
	const close = (frame: Frame): ValueRef | undefined => {
		const refs = frame.refs;
		const items: ValuePage = frame.array
			? { kind: "array", items: refs, next: frame.next }
			: { kind: "object", items: pairs(refs), next: frame.next };
		frame.next = take(items, frame.next ? [...refs, frame.next] : refs);
		if (frame.end > VALUE_PAGE_ITEMS) {
			frame.end -= VALUE_PAGE_ITEMS;
			slice(frame);
			return undefined;
		}
		stack.pop();
		ancestors.delete(frame.object);
		return frame.next;
	};
	try {
		let pending: { readonly value: unknown } | undefined = { value };
		let done: ValueRef | undefined;
		for (;;) {
			if (pending) {
				const current = pending.value;
				pending = undefined;
				if (
					scalar(current) ||
					(typeof current === "string" && JSON.stringify(current).length <= INLINE_JSON_LENGTH)
				)
					done = { node: 0, owner: 0, value: current };
				else if (typeof current === "string") done = ownString(current);
				else if (plain(current)) open(current);
				else throw new CompactWriteError("unsupported_value");
			}
			const frame = stack[stack.length - 1];
			if (done) {
				if (!frame) return done;
				frame.refs.push(done);
				done = undefined;
			}
			if (!frame) throw new CompactWriteError("unsupported_value");
			if (frame.index < frame.children.length) pending = { value: frame.children[frame.index++] };
			else done = close(frame);
		}
	} catch (error) {
		for (const owner of owned) store.adjust(owner, -1, 0);
		throw error;
	}
}

function pairs(refs: readonly ValueRef[]): (readonly [ValueRef, ValueRef])[] {
	const fields: (readonly [ValueRef, ValueRef])[] = [];
	for (let index = 0; index + 1 < refs.length; index += 2) fields.push([refs[index], refs[index + 1]]);
	return fields;
}
