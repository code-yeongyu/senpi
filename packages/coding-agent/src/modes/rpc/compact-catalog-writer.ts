import { COMPACT_LEAF_CODE_UNITS, type CompactContentStore, type LeafId } from "./compact-content-store.ts";
import type { CatalogComponent } from "./compact-recovery-catalog.ts";
import type { BoundedId } from "./compact-recovery-ids.ts";
import type { ValueStep } from "./compact-values.ts";

/**
 * Writes one catalog component as bounded store leaves: text arrives in fragments of any size and leaves at most
 * one open leaf (<= COMPACT_LEAF_CODE_UNITS) in memory, whatever the component's total size. `finish` hands the
 * leaves to one owner the caller releases once the catalog has placed the component; `abort` releases what a
 * failed component already wrote.
 */
class CatalogComponentWriter {
	private readonly store: CompactContentStore;
	private readonly leaves: LeafId[] = [];
	private open = "";

	constructor(store: CompactContentStore) {
		this.store = store;
	}

	push(text: string): void {
		let rest = text;
		while (this.open.length + rest.length > COMPACT_LEAF_CODE_UNITS) {
			const take = COMPACT_LEAF_CODE_UNITS - this.open.length;
			this.seal(this.open + rest.slice(0, take));
			rest = rest.slice(take);
		}
		this.open += rest;
	}

	finish(kind: BoundedId, id: BoundedId): CatalogComponent {
		if (this.open.length > 0) this.seal(this.open);
		this.open = "";
		const owner = this.store.text.own(this.leaves);
		for (const leaf of this.leaves) this.store.adjust(leaf, -1, 0);
		return { kind, id, leaves: [...this.leaves], owner };
	}

	abort(): void {
		for (const leaf of this.leaves) this.store.adjust(leaf, -1, 0);
		this.leaves.length = 0;
		this.open = "";
	}

	private seal(text: string): void {
		this.leaves.push(this.store.createLeaf(text, true));
		this.open = "";
	}
}

/**
 * One component as the catalog consumes it: `fill` writes its text, the component is yielded once, and its owner is
 * released when the consumer resumes the generator, which the catalog does only after it has placed the component
 * and holds its own reference. A failure while filling releases whatever was written and reports no component.
 */
export async function* writtenComponent(
	store: CompactContentStore,
	kind: BoundedId,
	id: BoundedId,
	fill: (writer: CatalogComponentWriter) => Promise<void> | void,
): AsyncGenerator<CatalogComponent> {
	const writer = new CatalogComponentWriter(store);
	let component: CatalogComponent;
	try {
		await fill(writer);
		component = writer.finish(kind, id);
	} catch (cause) {
		writer.abort();
		throw cause;
	}
	try {
		yield component;
	} finally {
		store.adjust(component.owner, -1, 0);
	}
}

interface Frame {
	readonly container: "array" | "object";
	emitted: number;
}

const HIGH_SURROGATE = /[\uD800-\uDBFF]$/;

/**
 * The canonical JSON text of a walked value, fragment by fragment: byte-identical to `JSON.stringify` of the value
 * read whole, with the walk's bounded residency. A string chunk is escaped as it arrives; a high surrogate ending a
 * chunk waits for its pair in the next one, so a pair split at a page edge is emitted raw exactly as a whole
 * `JSON.stringify` would, and only a truly lone surrogate is escaped.
 */
export async function* encodeValueSteps(steps: AsyncIterable<ValueStep>): AsyncGenerator<string> {
	const stack: Frame[] = [];
	let carry = "";
	let inString = false;
	const separator = (): string => {
		const frame = stack[stack.length - 1];
		if (!frame) return "";
		const count = frame.emitted++;
		if (frame.container === "array") return count > 0 ? "," : "";
		return count === 0 ? "" : count % 2 === 0 ? "," : ":";
	};
	for await (const step of steps) {
		switch (step.kind) {
			case "scalar":
				yield `${separator()}${JSON.stringify(step.value)}`;
				break;
			case "string": {
				const prefix = inString ? "" : `${separator()}"`;
				let text = carry + step.text;
				carry = "";
				if (step.more && HIGH_SURROGATE.test(text)) {
					carry = text.slice(-1);
					text = text.slice(0, -1);
				}
				inString = step.more;
				yield `${prefix}${JSON.stringify(text).slice(1, -1)}${step.more ? "" : '"'}`;
				break;
			}
			case "open":
				yield `${separator()}${step.container === "array" ? "[" : "{"}`;
				stack.push({ container: step.container, emitted: 0 });
				break;
			case "close":
				yield stack.pop()?.container === "array" ? "]" : "}";
				break;
			default:
				return assertNever(step);
		}
	}
}

function assertNever(step: never): never {
	throw new Error(`unexpected value step: ${JSON.stringify(step)}`);
}
