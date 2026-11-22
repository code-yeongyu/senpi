import type { EventLoopSlicer } from "../../../../event-loop-slicer.ts";

const ACTIVATION_MARKER_PREFIX = "[tool_search:activated";

/**
 * Whether `JSON.stringify(message)` could contain an activation marker, without serializing it.
 *
 * Exact for plain JSON data: the marker has no character JSON escapes and cannot be formed by
 * JSON punctuation (after `[` JSON allows only a value, never `t` followed by `ool_`), so it
 * appears in the serialized blob only inside one key or string value. A `toJSON` object is
 * reported as a candidate because its serialization is not visible here. Serializing every
 * message of a large transcript to look for a marker held the host loop for ~0.7 s per open
 * (senpi#3518); a string scan finds the rare candidates for a fraction of that.
 */
export function mayHoldActivationMarker(message: unknown): boolean {
	return holds(message, new Set());
}

function holds(value: unknown, seen: Set<object>): boolean {
	if (typeof value === "string" || value instanceof String) return value.includes(ACTIVATION_MARKER_PREFIX);
	if (typeof value !== "object" || value === null || seen.has(value)) return false;
	seen.add(value);
	if (typeof (value as { toJSON?: unknown }).toJSON === "function") return true;
	if (Array.isArray(value)) return value.some((item) => holds(item, seen));
	for (const [key, item] of Object.entries(value)) {
		if (key.includes(ACTIVATION_MARKER_PREFIX) || holds(item, seen)) return true;
	}
	return false;
}

export async function activationMarkerCandidates(
	messages: readonly unknown[],
	slicer: EventLoopSlicer,
): Promise<unknown[]> {
	const candidates: unknown[] = [];
	for (const message of messages) {
		if (mayHoldActivationMarker(message)) candidates.push(message);
		if (slicer.due) await slicer.yield();
	}
	return candidates;
}
