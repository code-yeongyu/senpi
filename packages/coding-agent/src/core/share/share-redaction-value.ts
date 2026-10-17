import {
	count,
	redactShareText,
	SENSITIVE_KEY,
	type ShareRedactionContext,
	type ShareRedactionTally,
} from "./share-redaction.ts";

/** Any provider's image block: pi `{type:"image"}`, Anthropic `{type:"image", source}`, OpenAI `image_url`/`input_image`. */
function isImageBlock(value: Record<string, unknown>): boolean {
	if (typeof value.type === "string" && /image/i.test(value.type)) return true;
	const source = value.source;
	return typeof source === "object" && source !== null && Reflect.get(source, "type") === "base64";
}

/** Every string under a sensitive key is a credential, whatever the nesting (`{"Authorization": ["Bearer x"]}`). */
function dropAllStrings(value: unknown, tally: ShareRedactionTally): unknown {
	if (typeof value === "string") {
		if (value.length === 0 || value.startsWith("<redacted")) return value;
		count(tally, "credential");
		return "<redacted>";
	}
	if (Array.isArray(value)) return value.map((item) => dropAllStrings(item, tally));
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, dropAllStrings(child, tally)]));
}

/**
 * Redacts every string reachable from `value` (keys stay, they are schema);
 * every value under a sensitive-named key is dropped whole, and image payloads
 * are replaced by a text note because their pixels cannot be checked.
 */
export function redactShareValue<T>(value: T, context: ShareRedactionContext, tally: ShareRedactionTally): T {
	return redactNode(value, context, tally) as T;
}

function redactNode(value: unknown, context: ShareRedactionContext, tally: ShareRedactionTally): unknown {
	if (typeof value === "string") return redactShareText(value, context, tally);
	if (Array.isArray(value)) return value.map((item) => redactNode(item, context, tally));
	if (value === null || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	if (isImageBlock(record)) {
		count(tally, "image");
		return { type: "text", text: "[image omitted from share]" };
	}
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(record)) {
		out[key] = SENSITIVE_KEY.test(key) ? dropAllStrings(child, tally) : redactNode(child, context, tally);
	}
	return out;
}
