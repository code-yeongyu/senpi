import { redactAcrossBoundary } from "./share-entropy.ts";
import { count, redactShareText, type ShareRedactionContext, type ShareRedactionTally } from "./share-redaction.ts";
import { isSensitiveKeyName } from "./share-sensitive-key.ts";

/** Any provider's image block: pi `{type:"image"}`, Anthropic `{type:"image", source}`, OpenAI `image_url`/`input_image`. */
function isImageBlock(value: Record<string, unknown>): boolean {
	if (typeof value.type === "string" && /image/i.test(value.type)) return true;
	const source = value.source;
	return typeof source === "object" && source !== null && Reflect.get(source, "type") === "base64";
}

const SCHEMA_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
const SCHEMA_KEYWORDS = new Set([
	"type",
	"description",
	"title",
	"format",
	"enum",
	"items",
	"properties",
	"required",
	"minLength",
	"maxLength",
	"pattern",
	"additionalProperties",
	"nullable",
]);

/** A JSON-schema node (a tool parameter named `apiKey`) describes a credential; it does not hold one. */
function isSchemaNode(value: unknown): boolean {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const type = Reflect.get(value, "type");
	if (typeof type !== "string" || !SCHEMA_TYPES.has(type)) return false;
	return Object.keys(value).every((key) => SCHEMA_KEYWORDS.has(key));
}

/** Every string under a sensitive key is a credential, whatever the nesting (`{"Authorization": ["Bearer x"]}`). */
function dropAllStrings(value: unknown, tally: ShareRedactionTally): unknown {
	if (typeof value === "string") {
		if (value.length === 0) return value;
		if (value !== "<redacted>") count(tally, "credential");
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
	if (Array.isArray(value))
		return joinAdjacentText(
			value.map((item) => redactNode(item, context, tally)),
			tally,
		);
	if (value === null || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	if (isImageBlock(record)) {
		count(tally, "image");
		return { type: "text", text: "[image omitted from share]" };
	}
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(record)) {
		out[key] =
			isSensitiveKeyName(key) && !isSchemaNode(child)
				? dropAllStrings(child, tally)
				: redactNode(child, context, tally);
	}
	return out;
}

function textOf(item: unknown): string | undefined {
	if (typeof item === "string") return item;
	if (item === null || typeof item !== "object" || Reflect.get(item, "type") !== "text") return undefined;
	const text = Reflect.get(item, "text");
	return typeof text === "string" ? text : undefined;
}

function withText(item: unknown, text: string): unknown {
	return typeof item === "string" ? text : { ...(item as Record<string, unknown>), text };
}

/** A token split across two adjacent text blocks or strings is one value; both halves go. */
function joinAdjacentText(items: unknown[], tally: ShareRedactionTally): unknown[] {
	for (let index = 0; index + 1 < items.length; index++) {
		const left = textOf(items[index]);
		const right = textOf(items[index + 1]);
		if (left === undefined || right === undefined) continue;
		const [nextLeft, nextRight] = redactAcrossBoundary(left, right, () => count(tally, "credential"));
		if (nextLeft !== left) {
			items[index] = withText(items[index], nextLeft);
			items[index + 1] = withText(items[index + 1], nextRight);
		}
	}
	return items;
}
