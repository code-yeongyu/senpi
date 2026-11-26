import type { AssistantMessage } from "@earendil-works/pi-ai";

export type AssistantSemanticProjection = {
	role: AssistantMessage["role"];
	api: AssistantMessage["api"];
	provider: AssistantMessage["provider"];
	model: AssistantMessage["model"];
	content: unknown[];
};

const MAX_DIVERGENCE_DEPTH = 16;
// The walk starts at `arguments`, one level below the block the snapshot starts at, and still compares one level past
// its cap; the snapshot copies two levels further so every value the walk can reach is a copy, not a shared reference.
const MAX_SNAPSHOT_DEPTH = MAX_DIVERGENCE_DEPTH + 2;
// Argument keys are model-produced data: only a short plain identifier is named in a path. Anything else (long,
// or containing `.`/`[` that would make the path ambiguous) is named by its sorted position, never by its text.
const PLAIN_KEY = /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/;

function keySegment(key: string, position: number): string {
	return PLAIN_KEY.test(key) ? `.${key}` : `.<key#${position}>`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The captured projection must be a snapshot, not a reference: the rewrite
 * class this exists for (senpi#1472, senpi#1975) mutates tool-call arguments in
 * place between `message_update` and `message_end`, and a shared reference
 * would follow the mutation and blind the walk to exactly that case.
 */
export function snapshotProjection(projection: AssistantSemanticProjection): AssistantSemanticProjection {
	return { ...projection, content: projection.content.map((block) => snapshotValue(block, 0)) };
}

function snapshotValue(value: unknown, depth: number): unknown {
	if (depth > MAX_SNAPSHOT_DEPTH) return value;
	if (Array.isArray(value)) return value.map((item) => snapshotValue(item, depth + 1));
	if (!isRecord(value)) return value;
	return Object.fromEntries(Object.keys(value).map((key) => [key, snapshotValue(value[key], depth + 1)]));
}

function fieldOf(block: unknown, field: string): unknown {
	return isRecord(block) ? block[field] : undefined;
}

/**
 * First diverged sub-path between two JSON-shaped values: objects contribute
 * `.key` (sorted, so the path is deterministic), arrays contribute `[n]`, and a
 * length difference names the first index present on only one side. Returns ""
 * when the values at this position differ and undefined when they are equal;
 * past the depth cap the parent position is named instead of recursing.
 */
function firstDivergedSegment(left: unknown, right: unknown, depth: number): string | undefined {
	if (left === right) return undefined;
	if (depth > MAX_DIVERGENCE_DEPTH) return "";
	if (Array.isArray(left) && Array.isArray(right)) {
		const shared = Math.min(left.length, right.length);
		for (let index = 0; index < shared; index += 1) {
			const inner = firstDivergedSegment(left[index], right[index], depth + 1);
			if (inner !== undefined) return `[${index}]${inner}`;
		}
		return left.length === right.length ? undefined : `[${shared}]`;
	}
	if (isRecord(left) && isRecord(right)) {
		const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
		for (const [position, key] of keys.entries()) {
			const inner = firstDivergedSegment(left[key], right[key], depth + 1);
			if (inner !== undefined) return `${keySegment(key, position)}${inner}`;
		}
		return undefined;
	}
	return "";
}

function firstDivergedBlockField(index: number, left: unknown, right: unknown): string | undefined {
	const kind = fieldOf(left, "type");
	if (kind !== fieldOf(right, "type")) return `content[${index}].type`;
	const scalarFields =
		kind === "text"
			? ["text"]
			: kind === "thinking"
				? ["thinking", "thinkingSignature"]
				: kind === "toolCall"
					? ["id", "name"]
					: undefined;
	if (scalarFields === undefined) {
		const segment = firstDivergedSegment(left, right, 0);
		return segment === undefined ? undefined : `content[${index}]${segment}`;
	}
	const field = scalarFields.find((name) => fieldOf(left, name) !== fieldOf(right, name));
	if (field !== undefined) return `content[${index}].${field}`;
	if (kind !== "toolCall") return undefined;
	const argumentsSegment = firstDivergedSegment(fieldOf(left, "arguments"), fieldOf(right, "arguments"), 0);
	return argumentsSegment === undefined ? undefined : `content[${index}].arguments${argumentsSegment}`;
}

/**
 * First diverged path between the provider-final and committed projections:
 * `content.length`, then per block `type`, its semantic fields, and for
 * toolCall blocks `arguments.<path>`, then `api` / `provider` / `model`.
 * Only paths leave this function; no value from either side is embedded.
 */
export function firstDivergedPath(
	providerFinal: AssistantSemanticProjection,
	committed: AssistantSemanticProjection,
): string {
	if (providerFinal.content.length !== committed.content.length) return "content.length";
	for (let index = 0; index < providerFinal.content.length; index += 1) {
		const path = firstDivergedBlockField(index, providerFinal.content[index], committed.content[index]);
		if (path !== undefined) return path;
	}
	const identityField = (["api", "provider", "model"] as const).find(
		(field) => providerFinal[field] !== committed[field],
	);
	return identityField ?? "content";
}
