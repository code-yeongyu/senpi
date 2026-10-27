import { parseStreamingJson } from "@earendil-works/pi-ai";
import type { CompactContentStore } from "./compact-content-store.ts";
import type { FrozenSeededBlock } from "./compact-seeded-block.ts";
import { CompactValues } from "./compact-values.ts";

/** Compatibility observation only: acceptance neither parses raw spelling nor assembles public values. */
export async function readSeededBlock(
	store: CompactContentStore,
	block: FrozenSeededBlock,
	context: { readonly text: string; readonly valid: () => void },
) {
	const values = new CompactValues(store);
	const fields: Record<string, unknown> = {};
	for (const [key, ref] of Object.entries(block.fields)) {
		const value = await values.read(ref);
		context.valid();
		Object.defineProperty(fields, key, { value, enumerable: true, configurable: true, writable: true });
	}
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
