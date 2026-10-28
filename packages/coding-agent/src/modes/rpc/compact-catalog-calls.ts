import type { FrozenCalls, OutstandingCall } from "./compact-call-model.ts";
import { familyId, memberId } from "./compact-catalog-registry.ts";
import {
	type CatalogReader,
	type CatalogStep,
	literalSteps,
	objectSteps,
	type Steps,
	textSteps,
	walkedSteps,
} from "./compact-catalog-steps.ts";
import { emptyComponent, stepsComponent } from "./compact-catalog-writer.ts";
import { CompactComponentRoots } from "./compact-component-roots.ts";
import { CompactReadError } from "./compact-read-lease.ts";
import type { CatalogComponent } from "./compact-recovery-catalog.ts";
import type { ValueRef, ValueStep } from "./compact-values.ts";

const CALLS = familyId("calls");
const SLOTS: ReadonlySet<string> = new Set(["raw", "hook", "progress", "result"]);
type Scalar = string | number | boolean | null;
type Flat = Readonly<Record<string, Scalar>> | null;

const leaf = (value: Scalar | undefined): number => {
	if (typeof value !== "number") throw new CompactReadError("ownership");
	return value;
};

function flatSlot(steps: readonly ValueStep[]): Flat {
	const [first] = steps;
	if (first?.kind === "scalar" && first.value === null && steps.length === 1) return null;
	if (first?.kind !== "open" || first.container !== "object") throw new CompactReadError("ownership");
	const fields: Record<string, Scalar> = {};
	let key: string | undefined;
	let text = "";
	for (const step of steps.slice(1, -1)) {
		if (step.kind === "open" || step.kind === "close") throw new CompactReadError("ownership");
		if (step.kind === "string" && step.more) {
			text += step.text;
			continue;
		}
		const value = step.kind === "string" ? text + step.text : step.value;
		text = "";
		if (key !== undefined) {
			fields[key] = value;
			key = undefined;
		} else if (typeof value === "string") key = value;
		else throw new CompactReadError("ownership");
	}
	return fields;
}

/** An owned raw prefix is its text inline; a streaming one names the active block it reads through (R3.C3). */
function rawSteps({ store, valid }: CatalogReader, raw: Flat): Steps {
	if (raw?.kind !== "owned") return literalSteps(raw);
	return objectSteps([
		["kind", literalSteps("owned")],
		["text", textSteps(store.text, [leaf(raw.root), leaf(raw.tailRoot)], valid)],
	]);
}

function slotRef(slot: Flat): ValueRef | null {
	if (slot === null) return null;
	if ("value" in slot) return { node: 0, owner: 0, value: slot.value ?? null };
	return { node: leaf(slot.node), owner: leaf(slot.owner) };
}

const slotSteps = (reader: CatalogReader, name: string, slot: Flat): Steps =>
	name === "raw" ? rawSteps(reader, slot) : walkedSteps(reader.values, slotRef(slot), reader.valid);

/**
 * One stored call header as walk steps with one value page resident (#4568 review LOW 2): every field streams as
 * stored, `seed` and `input` included, and only a slot field (a raw descriptor or a value ref, a few scalars) is
 * collected and replaced by what it names. A slot's own walk starts after the header walk yielded that slot's last
 * step, which holds no page, so the two walks are never resident together.
 */
async function* headerSteps(reader: CatalogReader, ref: ValueRef): AsyncGenerator<CatalogStep> {
	let depth = 0;
	let key: string | undefined = "";
	let slot: { readonly name: string; readonly steps: ValueStep[] } | undefined;
	for await (const step of reader.values.walk(ref, reader.valid)) {
		const outer = depth;
		if (step.kind === "open") depth += 1;
		else if (step.kind === "close") depth -= 1;
		if (outer === 0 || depth === 0) {
			yield step;
			continue;
		}
		if (key !== undefined) {
			if (step.kind !== "string") throw new CompactReadError("ownership");
			key += step.text;
			yield step;
			if (step.more) continue;
			slot = SLOTS.has(key) ? { name: key, steps: [] } : undefined;
			key = undefined;
			continue;
		}
		if (slot) slot.steps.push(step);
		else yield step;
		if (depth !== 1 || (step.kind === "string" && step.more)) continue;
		if (slot) yield* slotSteps(reader, slot.name, flatSlot(slot.steps));
		slot = undefined;
		key = "";
	}
}

/** The calls family: one `call-<creation ordinal>` member per outstanding call of the cut, or the explicit empty. */
export async function* callsComponents(reader: CatalogReader, calls: FrozenCalls): AsyncGenerator<CatalogComponent> {
	const roots = new CompactComponentRoots<OutstandingCall>(reader.store, () => []);
	let count = 0;
	for await (const [order, ref] of roots.rows(calls.ref, reader.valid)) {
		yield* stepsComponent(reader.store, CALLS, memberId("call", order.replace(".", "-")), headerSteps(reader, ref));
		count += 1;
	}
	if (count === 0) yield emptyComponent("calls");
}
