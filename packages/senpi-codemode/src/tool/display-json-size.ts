// Display JSON size accounting shared by storage bounding and legacy rendering (#3261).

/** Model-facing display text budget; the stored jsonOutputs entry follows the same order of budget. */
export const MAX_DISPLAY_TEXT_BYTES = 8_000;
/**
 * Total serialized-size budget for one stored entry. Measured in characters (JS string length), so
 * non-ASCII text can store up to ~3x this many UTF-8 bytes; the bound is what matters (#3261 review).
 */
export const MAX_DISPLAY_JSON_BYTES = MAX_DISPLAY_TEXT_BYTES;

/**
 * Byte length of a `{type:"Buffer",data:[...]}` serialization, or undefined when the shape is not one.
 * Only a bounded prefix of the data array is validated, so a multi-MB legacy dump never gets walked (#3261).
 */
export function serializedBufferByteLength(value: unknown): number | undefined {
	if (!isRecord(value) || value.type !== "Buffer" || !Array.isArray(value.data)) return undefined;
	if (value.data.length === 0) return 0;
	const prefixLength = Math.min(value.data.length, 1_024);
	for (let index = 0; index < prefixLength; index += 1) {
		const byte = value.data[index];
		if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) return undefined;
	}
	return value.data.length;
}

export function formatByteLength(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Number((bytes / 1024).toFixed(1))} KB`;
	return `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`;
}

export function bufferPlaceholder(bytes: number): string {
	return `<Buffer ${formatByteLength(bytes)}>`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Length of value's JSON string body after escaping; bounded at 6x plus quotes, never serialized here. */
export function serializedStringLength(value: string): number {
	let length = 2;
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		// Control characters, quotes, backslashes and lone surrogates escape (up to \uXXXX); everything else
		// costs its UTF-16 length, so a character above U+FFFF counts as the two units JSON.stringify writes.
		const escaped =
			codePoint < 0x20 || character === '"' || character === "\\" || (codePoint >= 0xd800 && codePoint <= 0xdfff);
		length += escaped ? JSON.stringify(character).length : character.length;
	}
	return length;
}

/**
 * Iterative early-exit size estimate for stored entries (legacy sessions carry multi-MB ones); never
 * enumerates more of the value than the budget plus a key.
 */
export function displayJsonSizeExceeds(value: unknown, budget: number): boolean {
	let size = 0;
	const pending: unknown[] = [value];
	while (pending.length > 0) {
		const node = pending.pop();
		if (node === null || node === undefined) continue;
		if (typeof node === "boolean" || typeof node === "number") {
			size += 8;
		} else if (typeof node === "string") {
			size += node.length;
		} else if (Array.isArray(node)) {
			size += 2;
			for (const child of node) {
				size += 1;
				if (size > budget) return true;
				pending.push(child);
			}
		} else if (isRecord(node)) {
			size += 2;
			for (const key in node) {
				size += key.length + 1;
				if (size > budget) return true;
				pending.push(node[key]);
			}
		}
		if (size > budget) return true;
	}
	return false;
}
