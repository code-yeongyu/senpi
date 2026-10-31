import {
	bufferPlaceholder,
	isRecord,
	MAX_DISPLAY_JSON_BYTES,
	serializedBufferByteLength,
	serializedStringLength,
} from "./display-json-size.ts";
import {
	JSON_TREE_MAX_DEPTH_EXPANDED,
	JSON_TREE_MAX_LINES_EXPANDED,
	JSON_TREE_SCALAR_LEN_EXPANDED,
} from "./json-tree.ts";

const STUB = "…";
const STUB_COST = 3; // JSON.stringify("…")
const MAX_KEY_CHARS = 64;

function serializedLength(value: unknown): number {
	return value === undefined ? 0 : JSON.stringify(value).length;
}

function elisionMarker(elided: number): string {
	return `[…${elided}ch elided…]`;
}

/** keptLength moved back so the prefix never ends on the high half of a surrogate pair. */
function characterBoundary(value: string, keptLength: number): number {
	const last = value.charCodeAt(keptLength - 1);
	return keptLength > 0 && last >= 0xd800 && last <= 0xdbff ? keptLength - 1 : keptLength;
}

/** The longest prefix of value whose serialized length with its elision marker fits limit, or undefined. */
function trimmedString(value: string, maxChars: number, limit: number): string | undefined {
	let keptLength = characterBoundary(value, Math.min(maxChars, value.length));
	while (keptLength >= 0) {
		const candidate = `${value.slice(0, keptLength)}${elisionMarker(value.length - keptLength)}`;
		if (serializedStringLength(candidate) <= limit) return candidate;
		if (keptLength === 0) return undefined;
		keptLength = characterBoundary(value, Math.floor(keptLength / 2));
	}
	return undefined;
}

function boundString(value: string, limit: number): string {
	if (value.length <= JSON_TREE_SCALAR_LEN_EXPANDED && serializedStringLength(value) <= limit) return value;
	return trimmedString(value, JSON_TREE_SCALAR_LEN_EXPANDED, limit) ?? STUB;
}

/** Keys are display data too: long or escape-heavy keys keep a prefix and stay unique (#3261 review). */
function fittedKey(key: string, maxChars: number): string {
	return key.length <= maxChars && serializedStringLength(key) <= maxChars + 2
		? key
		: (trimmedString(key, maxChars, maxChars + 2) ?? STUB);
}

function boundKey(key: string, taken: Set<string>): string {
	let unique = fittedKey(key, MAX_KEY_CHARS);
	for (let suffix = 2; taken.has(unique); suffix += 1) {
		// The suffix fits inside the key limit so every stored key stays within MAX_KEY_CHARS.
		unique = `${fittedKey(key, MAX_KEY_CHARS - String(suffix).length - 1)}#${suffix}`;
	}
	taken.add(unique);
	return unique;
}

/**
 * Serialized length of what boundNode would keep given unlimited room, capped at cap + 1 so a
 * multi-MB value is never walked past what the budget could use.
 */
function boundedNeed(value: unknown, depth: number, cap: number): number {
	if (value === undefined) return 0;
	if (value === null || typeof value === "boolean" || typeof value === "number") return serializedLength(value);
	if (typeof value === "string") {
		if (value.length > cap || value.length > JSON_TREE_SCALAR_LEN_EXPANDED) return cap + 1;
		return Math.min(cap + 1, serializedStringLength(value));
	}
	const bufferBytes = serializedBufferByteLength(value);
	if (bufferBytes !== undefined) return serializedLength(bufferPlaceholder(bufferBytes));
	if (depth >= JSON_TREE_MAX_DEPTH_EXPANDED) return STUB_COST;
	let total = 2;
	if (Array.isArray(value)) {
		for (const item of value) {
			total += 1 + boundedNeed(item, depth + 1, cap - total);
			if (total > cap) return cap + 1;
		}
		return total;
	}
	if (isRecord(value)) {
		for (const key in value) {
			total += 2 + serializedStringLength(key) + boundedNeed(value[key], depth + 1, cap - total);
			if (total > cap) return cap + 1;
		}
		return total;
	}
	return Math.min(cap + 1, serializedStringLength(String(value)));
}

function boundArray(value: readonly unknown[], depth: number, limit: number): unknown {
	const kept: unknown[] = [];
	let used = 2;
	for (const [index, item] of value.entries()) {
		const marker = `… (${value.length - index} more items)`;
		const markerCost = serializedLength(marker) + (index > 0 ? 1 : 0);
		const isLast = index === value.length - 1;
		const room =
			limit - used - (index > 0 ? 1 : 0) - (isLast ? 0 : serializedLength(`… (${value.length} more items)`) + 1);
		if (index >= JSON_TREE_MAX_LINES_EXPANDED || room < STUB_COST + 8) {
			if (used + markerCost > limit) return kept.length === 0 ? STUB : kept;
			kept.push(marker);
			return kept;
		}
		const child = boundNode(item, depth + 1, room);
		used += (index > 0 ? 1 : 0) + (child === undefined ? 4 : serializedLength(child));
		kept.push(child);
	}
	return kept;
}

function boundRecord(value: Record<string, unknown>, depth: number, limit: number): unknown {
	const taken = new Set<string>();
	const keys = Object.keys(value);
	const shown = keys.slice(0, JSON_TREE_MAX_LINES_EXPANDED).map((key) => ({ key, stored: boundKey(key, taken) }));
	const overflowKey = boundKey("…", taken);
	const stubCost = (entry: { stored: string }) => serializedStringLength(entry.stored) + 2 + STUB_COST;
	const overflowCost = (count: number) =>
		count === 0 ? 0 : serializedStringLength(overflowKey) + 2 + serializedLength(`${count} more keys`);
	// Every shown key is guaranteed at least a stub value; keys that cannot all fit become a visible count.
	let base = 2 + shown.reduce((sum, entry) => sum + stubCost(entry), 0) + overflowCost(keys.length - shown.length);
	while (base > limit && shown.length > 0) {
		const dropped = shown.pop();
		if (dropped) base -= stubCost(dropped);
		base += overflowCost(keys.length - shown.length) - overflowCost(keys.length - shown.length - 1);
	}
	if (base > limit) return STUB;
	// Max-min fair share of the remaining room: small values are kept whole, large ones share what is left.
	let pool = limit - base;
	const needs = shown.map((entry) =>
		Math.max(0, boundedNeed(value[entry.key], depth + 1, pool + STUB_COST) - STUB_COST),
	);
	const order = shown.map((_, index) => index).sort((left, right) => (needs[left] ?? 0) - (needs[right] ?? 0));
	const results = new Map<number, unknown>();
	for (const [position, index] of order.entries()) {
		const entry = shown[index];
		if (!entry) continue;
		const share = Math.floor(pool / (order.length - position));
		const grant = Math.min(needs[index] ?? 0, share);
		const child = boundNode(value[entry.key], depth + 1, STUB_COST + grant);
		pool -= Math.max(0, serializedLength(child) - STUB_COST);
		results.set(index, child);
	}
	const kept: Record<string, unknown> = {};
	for (const [index, entry] of shown.entries()) kept[entry.stored] = results.get(index);
	if (keys.length > shown.length) kept[overflowKey] = `${keys.length - shown.length} more keys`;
	return kept;
}

/**
 * Serialized length of value when bounding would keep it unchanged (no cap, depth, key, or Buffer rule
 * applies), or Infinity otherwise; stops counting past cap so large values are never walked in full.
 */
function unchangedLength(value: unknown, depth: number, cap: number): number {
	if (value === undefined || value === null || typeof value === "boolean" || typeof value === "number") {
		return value === undefined ? 4 : serializedLength(value);
	}
	if (typeof value === "string") {
		return value.length > JSON_TREE_SCALAR_LEN_EXPANDED || value.length > cap
			? Number.POSITIVE_INFINITY
			: serializedStringLength(value);
	}
	if (depth >= JSON_TREE_MAX_DEPTH_EXPANDED || serializedBufferByteLength(value) !== undefined) {
		return Number.POSITIVE_INFINITY;
	}
	let total = 2;
	if (Array.isArray(value)) {
		if (value.length > JSON_TREE_MAX_LINES_EXPANDED) return Number.POSITIVE_INFINITY;
		for (const item of value) {
			total += 1 + unchangedLength(item, depth + 1, cap - total);
			if (total > cap) return Number.POSITIVE_INFINITY;
		}
		return total;
	}
	if (isRecord(value)) {
		let count = 0;
		for (const key in value) {
			count += 1;
			if (count > JSON_TREE_MAX_LINES_EXPANDED || key.length > MAX_KEY_CHARS) return Number.POSITIVE_INFINITY;
			const keyLength = serializedStringLength(key);
			if (keyLength > MAX_KEY_CHARS + 2) return Number.POSITIVE_INFINITY;
			total += 2 + keyLength + unchangedLength(value[key], depth + 1, cap - total);
			if (total > cap) return Number.POSITIVE_INFINITY;
		}
		return total;
	}
	return Number.POSITIVE_INFINITY;
}

/** The value bounded so its serialized length is at most max(limit, 3). */
function boundNode(value: unknown, depth: number, limit: number): unknown {
	if (value === undefined) return value;
	// A value that already fits as it is stays exactly as it is.
	if (unchangedLength(value, depth, limit) <= limit) return value;
	if (value === null || typeof value === "boolean" || typeof value === "number") {
		return serializedLength(value) <= limit ? value : STUB;
	}
	if (typeof value === "string") return boundString(value, limit);
	const bufferBytes = serializedBufferByteLength(value);
	if (bufferBytes !== undefined) {
		const placeholder = bufferPlaceholder(bufferBytes);
		return serializedLength(placeholder) <= limit ? placeholder : STUB;
	}
	if (depth >= JSON_TREE_MAX_DEPTH_EXPANDED || limit < STUB_COST + 2) return STUB;
	if (Array.isArray(value)) return boundArray(value, depth, limit);
	if (isRecord(value)) return boundRecord(value, depth, limit);
	return boundString(String(value), limit);
}

/** Every top-level key with a stub value, or a bare stub when even that cannot fit. */
function skeleton(value: unknown): unknown {
	if (!isRecord(value)) return STUB;
	const stubbed = boundRecord(
		Object.fromEntries(Object.keys(value).map((key) => [key, STUB])),
		0,
		MAX_DISPLAY_JSON_BYTES,
	);
	return serializedLength(stubbed) <= MAX_DISPLAY_JSON_BYTES ? stubbed : STUB;
}

/**
 * Bounds one display value for persistence in `details.jsonOutputs`. The value is trimmed inside, never
 * replaced: every shown key keeps at least a stub, serialized Buffers become `<Buffer N>`, long strings,
 * arrays and objects carry a visible `… elided` / `N more items` / `N more keys` marker, keys are
 * trimmed like strings, and the real serialized length is checked last (#3261 review).
 */
export function sanitizeDisplayJson(value: unknown): unknown {
	const sanitized = boundNode(value, 0, MAX_DISPLAY_JSON_BYTES);
	return serializedLength(sanitized) <= MAX_DISPLAY_JSON_BYTES ? sanitized : skeleton(value);
}
