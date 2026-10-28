import type { CallRaw, FrozenCalls, OutstandingCall } from "./compact-call-model.ts";
import { familyId, memberId } from "./compact-catalog-registry.ts";
import {
	type CatalogReader,
	literalFields,
	literalSteps,
	objectSteps,
	type Steps,
	textSteps,
	walkedSteps,
} from "./compact-catalog-steps.ts";
import { emptyComponent, stepsComponent } from "./compact-catalog-writer.ts";
import { CompactComponentRoots } from "./compact-component-roots.ts";
import type { CatalogComponent } from "./compact-recovery-catalog.ts";

const CALLS = familyId("calls");

/** An owned raw prefix is its text inline; a streaming one names the active block it reads through (R3.C3). */
const rawSteps = ({ store, valid }: CatalogReader, raw: CallRaw | null): Steps =>
	raw?.kind === "owned"
		? objectSteps([
				["kind", literalSteps("owned")],
				["text", textSteps(store.text, [raw.root, raw.tailRoot], valid)],
			])
		: literalSteps(raw);

/** The call header as stored, with its raw prefix and every owned slot resolved to its value. */
function callSteps(reader: CatalogReader, call: OutstandingCall): Steps {
	const { hook, progress, result, raw, ...header } = call;
	const { values, valid } = reader;
	return objectSteps([
		...literalFields(header),
		["raw", rawSteps(reader, raw)],
		["hook", walkedSteps(values, hook, valid)],
		["progress", walkedSteps(values, progress, valid)],
		["result", walkedSteps(values, result, valid)],
	]);
}

/** The calls family: one `call-<creation ordinal>` member per outstanding call of the cut, or the explicit empty. */
export async function* callsComponents(reader: CatalogReader, calls: FrozenCalls): AsyncGenerator<CatalogComponent> {
	const roots = new CompactComponentRoots<OutstandingCall>(reader.store, () => []);
	let count = 0;
	for await (const [order, call] of roots.entries(calls.ref, reader.valid)) {
		yield* stepsComponent(reader.store, CALLS, memberId("call", order.replace(".", "-")), callSteps(reader, call));
		count += 1;
	}
	if (count === 0) yield emptyComponent("calls");
}
