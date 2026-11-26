import { type ActiveBlock, adjustBlock, appendBlock } from "./compact-active-block.ts";
import type { CompactContentStore } from "./compact-content-store.ts";
import type { CompactBlockKind } from "./compact-transition.ts";
import { CompactValues, type ValueRef } from "./compact-values.ts";

export type SeededFields = Readonly<Record<string, ValueRef>>;

/** Candidate payloads remain owned until publication acquires them or rejection releases them. */
export class CompactSeededDraft {
	readonly store: CompactContentStore;
	private readonly values: CompactValues;
	private readonly releases: (() => void)[] = [];

	constructor(store: CompactContentStore) {
		this.store = store;
		this.values = new CompactValues(store);
	}

	/** `removeNull` reads a message-metadata change, where `null` removes the field. */
	fields(value: object, previous: SeededFields = {}, removeNull = false): SeededFields {
		const result = { ...previous };
		for (const [key, item] of Object.entries(value)) {
			if (item === undefined) continue;
			if (item === null && removeNull) {
				Reflect.deleteProperty(result, key);
				continue;
			}
			const ref = this.values.own(item);
			this.releases.push(() => this.store.adjust(ref.owner, -1, 0));
			Object.defineProperty(result, key, { value: ref, enumerable: true, configurable: true, writable: true });
		}
		return result;
	}

	text(kind: CompactBlockKind, text = ""): ActiveBlock {
		const block: ActiveBlock = {
			kind,
			root: 0,
			tail: "",
			tailRoot: 0,
			units: 0,
			emitted: 0,
			covered: 0,
			witness: "",
		};
		this.releases.push(() => adjustBlock(this.store, block, -1));
		appendBlock(this.store, block, text);
		block.emitted = block.units;
		return block;
	}

	clone(block: ActiveBlock): ActiveBlock {
		const candidate = { ...block };
		adjustBlock(this.store, candidate, 1);
		this.releases.push(() => adjustBlock(this.store, candidate, -1));
		return candidate;
	}

	[Symbol.dispose](): void {
		for (const release of this.releases.reverse()) release();
	}
}
