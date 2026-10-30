import { type CompactContentStore, type LeafId, CompactWriteError } from "./compact-content-store.ts";
import { CompactReadError } from "./compact-read-lease.ts";

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

	own(value: unknown): ValueRef {
		const owned = new Set<LeafId>();
		const ancestors = new Set<object>();
		let nodes = 0,
			bytes = 0;
		const take = (page: ValuePage, children: readonly ValueRef[] = []): ValueRef => {
			bytes += Buffer.byteLength(JSON.stringify(page));
			if (bytes > 16 * 1024 * 1024) throw new CompactWriteError("size_limit");
			const ref = this.make(page);
			owned.add(ref.owner);
			for (const child of children) {
				this.store.adjust(child.owner, -1, 0);
				owned.delete(child.owner);
			}
			return ref;
		};
		const visit = (value: unknown, depth: number): ValueRef => {
			if (depth > 128) throw new CompactWriteError("depth_limit");
			if (++nodes > 100_000) throw new CompactWriteError("count_limit");
			const scalar =
				value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
			if (
				!scalar &&
				typeof value !== "string" &&
				(typeof value !== "object" ||
					(!Array.isArray(value) &&
						Object.getPrototypeOf(value) !== Object.prototype &&
						Object.getPrototypeOf(value) !== null))
			)
				throw new CompactWriteError("unsupported_value");
			if (typeof value === "string" && value.length * 2 > 16 * 1024 * 1024)
				throw new CompactWriteError("size_limit");
			if (scalar || (typeof value === "string" && JSON.stringify(value).length <= 64)) {
				bytes += Buffer.byteLength(JSON.stringify(value));
				if (bytes > 16 * 1024 * 1024) throw new CompactWriteError("size_limit");
				return { node: 0, owner: 0, value: value as string | number | boolean | null };
			}
			let next: ValueRef | undefined;
			if (typeof value === "string") {
				for (let end = value.length; end > 0; end = Math.max(0, end - 4096)) {
					next = take(
						{ kind: "string", text: value.slice(Math.max(0, end - 4096), end), next },
						next ? [next] : [],
					);
				}
			} else {
				const object = value as object;
				if (ancestors.has(object)) throw new CompactWriteError("cycle");
				ancestors.add(object);
				const array = Array.isArray(value);
				const entries = array ? value : Object.entries(object);
				if (nodes + entries.length > 100_000) throw new CompactWriteError("count_limit");
				for (let end = entries.length; end > 0 || !next; end = Math.max(0, end - 128)) {
					const slice = entries.slice(Math.max(0, end - 128), end);
					const items = array ? Array.from(slice, (item: unknown) => visit(item, depth + 1)) : [];
					const fields: Field[] = array
						? []
						: slice.map(([key, item]: [string, unknown]) => [visit(key, depth + 1), visit(item, depth + 1)]);
					next = take(array ? { kind: "array", items, next } : { kind: "object", items: fields, next }, [
						...items,
						...fields.flat(),
						...(next ? [next] : []),
					]);
					if (end <= 128) break;
				}
				ancestors.delete(object);
			}
			if (!next) throw new CompactWriteError("unsupported_value");
			return next;
		};
		try {
			return visit(value, 0);
		} catch (error) {
			for (const owner of owned) this.store.adjust(owner, -1, 0);
			throw error;
		}
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

	async read(ref: ValueRef): Promise<unknown> {
		if ("value" in ref) return ref.value;
		let next: ValueRef | undefined = ref;
		let text = "";
		const array: unknown[] = [],
			object: Record<string, unknown> = {};
		let kind: ValuePage["kind"] | undefined;
		while (next) {
			using held = await this.page(next);
			const page = held.value;
			kind ??= page.kind;
			if (kind !== page.kind) throw new CompactReadError("ownership");
			if (page.kind === "scalar") return page.value;
			if (page.kind === "string") text += page.text;
			if (page.kind === "array") for (const child of page.items) array.push(await this.read(child));
			if (page.kind === "object")
				for (const [key, value] of page.items) {
					const name = await this.read(key);
					if (typeof name !== "string") throw new CompactReadError("ownership");
					Object.defineProperty(object, name, {
						value: await this.read(value),
						enumerable: true,
						configurable: true,
					});
				}
			next = page.next;
		}
		return kind === "string" ? text : kind === "array" ? array : object;
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
