import { parseStreamingJson } from "@earendil-works/pi-ai";
import type { CompactContentStore } from "./compact-content-store.ts";
import type { FrozenSeededBlock } from "./compact-seeded-block.ts";
import type { SeededFields } from "./compact-seeded-draft.ts";
import { CompactValues } from "./compact-values.ts";

export async function readSeededFields(store: CompactContentStore, fields: SeededFields, valid: () => void) {
	const values = new CompactValues(store);
	const result: Record<string, unknown> = {};
	for (const [key, ref] of Object.entries(fields)) {
		const value = await values.read(ref, valid);
		valid();
		Object.defineProperty(result, key, { value, enumerable: true, configurable: true, writable: true });
	}
	return result;
}

/** Compatibility observation only: acceptance neither parses raw spelling nor assembles public values. */
export async function readSeededBlock(
	store: CompactContentStore,
	block: FrozenSeededBlock,
	context: { readonly text: string; readonly valid: () => void },
) {
	const fields = await readSeededFields(store, block.fields, context.valid);
	let signature = "";
	for (const root of [block.signature.root, block.signature.tailRoot])
		for await (const part of store.text.chunks(root, context.valid)) signature += part;
	switch (block.type) {
		case "text":
			return { ...fields, text: context.text, ...("textSignature" in fields ? { textSignature: signature } : {}) };
		case "thinking":
			return {
				...fields,
				thinking: context.text,
				...("thinkingSignature" in fields ? { thinkingSignature: signature } : {}),
			};
		case "toolCall":
			return {
				...fields,
				...(block.phase === "open" && block.parsedThrough > 0
					? { arguments: parseStreamingJson(context.text.slice(0, block.parsedThrough)) }
					: {}),
			};
		default:
			return fields;
	}
}
