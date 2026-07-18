const BROKEN_UNICODE_ESCAPE = /\\u(?![0-9a-fA-F]{4})/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const REPLACEMENT_CHARACTER = "\uFFFD";

function isEscapedBackslashRun(text: string, backslashIndex: number): boolean {
	let precedingBackslashes = 0;
	for (let index = backslashIndex - 1; index >= 0 && text[index] === "\\"; index -= 1) {
		precedingBackslashes += 1;
	}
	return precedingBackslashes % 2 === 1;
}

/**
 * Fixes `\uXXXX` escape sequences that would make JSON.parse throw: a `\u`
 * not followed by four hex digits becomes a literal `\\u` so the surrounding
 * JSON stays parseable. Valid escapes and already-escaped backslashes are
 * left untouched.
 */
export function repairUnicodeEscapes(json: string): string {
	return json.replace(BROKEN_UNICODE_ESCAPE, (match, offset: number) =>
		isEscapedBackslashRun(json, offset) ? match : "\\\\u",
	);
}

/** Replaces unpaired UTF-16 surrogates with U+FFFD so values stay valid Unicode. */
export function repairLoneSurrogates(value: string): string {
	return value.replace(LONE_SURROGATE, REPLACEMENT_CHARACTER);
}

/** Applies {@link repairLoneSurrogates} to every string (keys included) in a JSON value. */
export function repairStringsDeep(value: unknown): unknown {
	if (typeof value === "string") {
		return repairLoneSurrogates(value);
	}
	if (Array.isArray(value)) {
		return value.map((entry) => repairStringsDeep(entry));
	}
	if (typeof value === "object" && value !== null) {
		const repaired: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			Object.defineProperty(repaired, repairLoneSurrogates(key), {
				configurable: true,
				enumerable: true,
				value: repairStringsDeep(entry),
				writable: true,
			});
		}
		return repaired;
	}
	return value;
}
