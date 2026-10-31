import { type CompactContentStore, type LeafId, CompactWriteError } from "./compact-content-store.ts";
import { CompactReadError } from "./compact-read-lease.ts";
import { ownValue } from "./compact-value-owner.ts";

export type ValueRef =
	| {
			readonly node: LeafId;
			readonly owner: LeafId;
	  }
	| { readonly node: 0; readonly owner: 0; readonly value: string | number | boolean | null };
type Field = readonly [ValueRef, ValueRef];
export type ValuePage =
	| { readonly kind: "scalar"; readonly value: number | boolean | null }
	| { readonly kind: "string"; readonly text: string; readonly next?: ValueRef }
	| { readonly kind: "array"; readonly items: readonly ValueRef[]; readonly next?: ValueRef }
	| { readonly kind: "object"; readonly items: readonly Field[]; readonly next?: ValueRef };
/** One bounded step of a value walk: a string arrives in page-sized chunks, an object alternates key and value. */
export type ValueStep =
	| { readonly kind: "scalar"; readonly value: number | boolean | null }
	| { readonly kind: "string"; readonly text: string; readonly more: boolean }
	| { readonly kind: "open"; readonly container: "array" | "object" }
	| { readonly kind: "close" };
interface WalkFrame {
	readonly kind: "array" | "object";
	items: readonly ValueRef[];
	index: number;
	next: ValueRef | undefined;
}

/** Field/array descriptors and string chunks live in bounded leaves; owners share immutable subtrees. */
export class CompactValues {
	private readonly store: CompactContentStore;
	residentPages = 0;
	peakResidentPages = 0;

	constructor(store: CompactContentStore) {
		this.store = store;
	}

	record(fields: ReadonlyMap<string, ValueRef>): ValueRef {
		const entries = [...fields];
		let next: ValueRef | undefined;
		for (let end = entries.length; end > 0 || !next; end = Math.max(0, end - 128)) {
			const items: Field[] = entries
				.slice(Math.max(0, end - 128), end)
				.map(([key, value]) => [this.own(key), value]);
			const ref = this.make({ kind: "object", items, next });
			for (const [key] of items) this.store.adjust(key.owner, -1, 0);
			if (next) this.store.adjust(next.owner, -1, 0);
			next = ref;
			if (end <= 128) break;
		}
		return next;
	}

	/** Owns a JSON-normal value through bounded pages; no aggregate size, depth or node cap (S03b-4). */
	own(value: unknown): ValueRef {
		return ownValue(this.store, (page) => this.make(page), value);
	}

	async page(ref: ValueRef) {
		this.residentPages++;
		this.peakResidentPages = Math.max(this.peakResidentPages, this.residentPages);
		try {
			const text = await this.store.readLeaf(ref.node);
			if (Buffer.byteLength(text) > 65_536) throw new CompactReadError("size_limit");
			const page: ValuePage = JSON.parse(text);
			if ((page.kind === "object" || page.kind === "array") && page.items.length > 128)
				throw new CompactReadError("count_limit");
			return {
				value: page,
				[Symbol.dispose]: () => {
					this.residentPages--;
				},
			};
		} catch (error) {
			this.residentPages--;
			throw error;
		}
	}

	/**
	 * The incremental read: one page resident at a time and one frame per open container, whatever the value's size
	 * or depth. `valid` runs after every page read, so a reader under a cut lease rechecks it between steps.
	 */
	async *walk(ref: ValueRef, valid?: () => void): AsyncGenerator<ValueStep> {
		const stack: WalkFrame[] = [];
		let pending: ValueRef | undefined = ref;
		let chunked = false;
		for (;;) {
			if (pending) {
				if ("value" in pending) {
					yield typeof pending.value === "string"
						? { kind: "string", text: pending.value, more: false }
						: { kind: "scalar", value: pending.value };
					pending = undefined;
					continue;
				}
				using held = await this.page(pending);
				valid?.();
				const page = held.value;
				if (chunked && page.kind !== "string") throw new CompactReadError("ownership");
				if (page.kind === "scalar") {
					yield { kind: "scalar", value: page.value };
					pending = undefined;
				} else if (page.kind === "string") {
					yield { kind: "string", text: page.text, more: page.next !== undefined };
					chunked = page.next !== undefined;
					pending = page.next;
				} else {
					yield { kind: "open", container: page.kind };
					stack.push({ kind: page.kind, items: page.items.flat(), index: 0, next: page.next });
					pending = undefined;
				}
				continue;
			}
			const frame = stack[stack.length - 1];
			if (!frame) return;
			if (frame.index < frame.items.length) {
				pending = frame.items[frame.index++];
			} else if (frame.next) {
				using held = await this.page(frame.next);
				valid?.();
				const page = held.value;
				if (page.kind !== frame.kind) throw new CompactReadError("ownership");
				frame.items = page.items.flat();
				frame.index = 0;
				frame.next = page.next;
			} else {
				stack.pop();
				yield { kind: "close" };
			}
		}
	}

	/** Whole-value assembly for a caller that wants the value itself; it costs the value's size, nothing more. */
	async read(ref: ValueRef, valid?: () => void): Promise<unknown> {
		if ("value" in ref) return ref.value;
		const stack: { readonly value: unknown[] | Record<string, unknown>; key: string | undefined }[] = [];
		let text: string | undefined;
		const settle = (value: unknown): unknown => {
			const parent = stack[stack.length - 1];
			if (!parent) return value;
			if (Array.isArray(parent.value)) parent.value.push(value);
			else if (parent.key === undefined) {
				if (typeof value !== "string") throw new CompactReadError("ownership");
				parent.key = value;
			} else {
				Object.defineProperty(parent.value, parent.key, {
					value,
					enumerable: true,
					configurable: true,
					writable: true,
				});
				parent.key = undefined;
			}
			return undefined;
		};
		let result: unknown;
		for await (const step of this.walk(ref, valid)) {
			if (step.kind === "open") stack.push({ value: step.container === "array" ? [] : {}, key: undefined });
			else if (step.kind === "close") {
				const frame = stack.pop();
				if (!frame) throw new CompactReadError("ownership");
				result = settle(frame.value);
			} else if (step.kind === "scalar") result = settle(step.value);
			else if (step.more) text = (text ?? "") + step.text;
			else {
				result = settle((text ?? "") + step.text);
				text = undefined;
			}
		}
		return result;
	}

	async *fields(ref: ValueRef): AsyncGenerator<readonly [string, ValueRef, ValueRef]> {
		let next: ValueRef | undefined = ref;
		while (next) {
			using held = await this.page(next);
			const page = held.value;
			if (page.kind !== "object") throw new CompactReadError("ownership");
			for (const [key, value] of page.items) {
				const name = await this.read(key);
				if (typeof name !== "string") throw new CompactReadError("ownership");
				yield [name, value, key];
			}
			next = page.next;
		}
	}

	/** Patches are coalesced before this call; copy descriptors, never the fields' payloads. */
	async merge(base: ValueRef, patch: ReadonlyMap<string, ValueRef>): Promise<ValueRef> {
		let reversed: ValueRef | undefined;
		let result: ValueRef | undefined;
		let buffer: Field[] = [];
		const seen = new Set<string>();
		const flush = async () => {
			const ref = this.make({ kind: "object", items: buffer, next: reversed });
			if (reversed) this.store.adjust(reversed.owner, -1, 0);
			reversed = ref;
			buffer = [];
			await this.store.flushLeaf(ref.node);
			if (!this.store.isCommitted(ref.node)) throw new CompactWriteError("storage_unavailable");
		};
		try {
			for await (const [name, value, key] of this.fields(base)) {
				if (patch.has(name)) seen.add(name);
				buffer.push([key, patch.get(name) ?? value]);
				if (buffer.length === 128) await flush();
			}
			for (const [name, value] of patch) {
				if (seen.has(name)) continue;
				const key = this.own(name);
				buffer.push([key, value]);
				// The key's initial reference is transferred to the completed page below.
				try {
					await flush();
				} finally {
					this.store.adjust(key.owner, -1, 0);
				}
			}
			if (buffer.length || !reversed) await flush();
			while (reversed) {
				using held = await this.page(reversed);
				const page = held.value;
				if (page.kind !== "object") throw new CompactReadError("ownership");
				const ref = this.make({ kind: "object", items: page.items, next: result });
				if (result) this.store.adjust(result.owner, -1, 0);
				result = ref;
				await this.store.flushLeaf(ref.node);
				if (!this.store.isCommitted(ref.node)) throw new CompactWriteError("storage_unavailable");
				const next = page.next;
				if (next) this.store.adjust(next.owner, 1, 0);
				this.store.adjust(reversed.owner, -1, 0);
				reversed = next;
			}
			if (!result) throw new CompactReadError("ownership");
			return result;
		} catch (error) {
			if (reversed) this.store.adjust(reversed.owner, -1, 0);
			if (result) this.store.adjust(result.owner, -1, 0);
			throw error;
		}
	}

	private make(page: ValuePage): ValueRef {
		const children = page.kind === "object" ? page.items.flat() : page.kind === "array" ? [...page.items] : [];
		if (page.kind !== "scalar" && page.next) children.push(page.next);
		const node = this.store.createLeaf(JSON.stringify(page), true);
		const owner = this.store.text.own([node, ...children.map((ref) => ref.owner)]);
		this.store.adjust(node, -1, 0);
		return { node, owner };
	}
}
