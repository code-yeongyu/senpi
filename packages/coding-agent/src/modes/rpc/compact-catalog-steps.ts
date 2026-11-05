import type { CompactContentStore, LeafId } from "./compact-content-store.ts";
import type { SeededFields } from "./compact-seeded-draft.ts";
import type { CompactTextRoots } from "./compact-text-roots.ts";
import type { CompactValues, ValueRef, ValueStep } from "./compact-values.ts";

/** A walk step, or a chunk of stored JSON text spliced in verbatim as one value (`more` until its last chunk). */
export type CatalogStep = ValueStep | { readonly kind: "raw"; readonly text: string; readonly more: boolean };
/** A member's value as the steps that encode it: a stored value's walk, a text range, stored JSON, or a literal. */
export type Steps = AsyncIterable<CatalogStep> | Iterable<CatalogStep>;
export type Field = readonly [string, Steps];

/** What every family adapter reads with: the cut's store, its value reader and the cut's validity check. */
export interface CatalogReader {
	readonly store: CompactContentStore;
	readonly values: CompactValues;
	readonly valid: () => void;
}

interface LiteralFrame {
	readonly children: readonly unknown[];
	index: number;
}

/**
 * The walk steps of a JSON-normal value already in memory (a call header, a descriptor row), produced iteratively
 * with one frame per open container, so a deep value never recurses.
 */
export function* literalSteps(value: unknown): Generator<ValueStep> {
	const stack: LiteralFrame[] = [];
	let pending: { readonly value: unknown } | undefined = { value };
	for (;;) {
		if (pending) {
			const current = pending.value;
			pending = undefined;
			if (typeof current === "string") yield { kind: "string", text: current, more: false };
			else if (typeof current === "object" && current !== null) {
				const array = Array.isArray(current);
				yield { kind: "open", container: array ? "array" : "object" };
				stack.push({ children: array ? current : Object.entries(current).flat(), index: 0 });
			} else if (typeof current === "number" || typeof current === "boolean" || current === null)
				yield { kind: "scalar", value: current };
			else yield { kind: "scalar", value: null };
			continue;
		}
		const frame = stack[stack.length - 1];
		if (!frame) return;
		if (frame.index < frame.children.length) pending = { value: frame.children[frame.index++] };
		else {
			stack.pop();
			yield { kind: "close" };
		}
	}
}

/** One JSON object from named fields, each field's value streamed from its own steps. */
export async function* objectSteps(fields: Iterable<Field> | AsyncIterable<Field>): AsyncGenerator<CatalogStep> {
	yield { kind: "open", container: "object" };
	for await (const [name, steps] of fields) {
		yield { kind: "string", text: name, more: false };
		yield* steps;
	}
	yield { kind: "close" };
}

export async function* arraySteps(items: Iterable<Steps> | AsyncIterable<Steps>): AsyncGenerator<CatalogStep> {
	yield { kind: "open", container: "array" };
	for await (const steps of items) yield* steps;
	yield { kind: "close" };
}

/** Stored JSON text (one value split across leaves) as the value itself, one leaf resident at a time. */
export async function* storedSteps(store: CompactContentStore, leaves: readonly LeafId[]): AsyncGenerator<CatalogStep> {
	for (const [index, leaf] of leaves.entries())
		yield { kind: "raw", text: await store.readLeaf(leaf), more: index + 1 < leaves.length };
}

export const literalFields = (value: object): Field[] =>
	Object.entries(value).map(([name, item]): Field => [name, literalSteps(item)]);

/** Stored text ranges as one JSON string, chunk by chunk, then a literal suffix; an empty range is `""`. */
export async function* textSteps(
	texts: CompactTextRoots,
	roots: readonly LeafId[],
	valid: () => void,
	suffix = "",
): AsyncGenerator<ValueStep> {
	for (const root of roots)
		for await (const chunk of texts.chunks(root, valid)) yield { kind: "string", text: chunk, more: true };
	yield { kind: "string", text: suffix, more: false };
}

/** Seeded fields (a record of stored values) as one object, each value walked with one page resident. */
export const fieldSteps = (
	values: CompactValues,
	fields: SeededFields,
	valid: () => void,
): AsyncGenerator<CatalogStep> =>
	objectSteps(Object.entries(fields).map(([name, ref]): Field => [name, values.walk(ref, valid)]));

export const walkedSteps = (values: CompactValues, ref: ValueRef | null, valid: () => void): Steps =>
	ref ? values.walk(ref, valid) : literalSteps(null);
