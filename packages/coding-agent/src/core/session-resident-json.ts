const OMIT_JSON_VALUE = Symbol("omit-json-value");

/**
 * Copies a JSON-compatible value with every string passed through `transformString`, failing exactly
 * where `JSON.stringify` would (BigInt, cycles) and dropping what it drops (undefined, functions).
 */
export function transformJson<T>(value: T, transformString: (text: string) => string): T {
	const transformed = transformJsonValue(value, transformString, "", new WeakSet());
	if (transformed === OMIT_JSON_VALUE) {
		const serialized = JSON.stringify(value);
		if (serialized === undefined) {
			throw new SyntaxError("JSON-compatible value expected");
		}
		return JSON.parse(serialized) as T;
	}
	return transformed as T;
}

function transformJsonValue(
	value: unknown,
	transformString: (text: string) => string,
	key: string,
	seen: WeakSet<object>,
): unknown | typeof OMIT_JSON_VALUE {
	if (typeof value === "string") {
		return transformString(value);
	}
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : null;
	}
	if (value === null || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "bigint") {
		// JSON.stringify semantics: a BigInt is not serializable, and the store's
		// contract is to fail exactly like it does.
		throw new TypeError("Do not know how to serialize a BigInt");
	}
	if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
		return OMIT_JSON_VALUE;
	}

	if (seen.has(value)) {
		throw new TypeError("Converting circular structure to JSON");
	}
	seen.add(value);

	const jsonValue = hasJsonSerializer(value) ? value.toJSON(key) : value;
	if (jsonValue !== value) {
		const transformed = transformJsonValue(jsonValue, transformString, key, seen);
		seen.delete(value);
		return transformed;
	}

	if (Array.isArray(value)) {
		const transformed = Array.from({ length: value.length }, (_item, index) => {
			const item = value[index];
			const transformedItem = transformJsonValue(item, transformString, String(index), seen);
			return transformedItem === OMIT_JSON_VALUE ? null : transformedItem;
		});
		seen.delete(value);
		return transformed;
	}

	const transformed: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		const transformedItem = transformJsonValue(item, transformString, String(key), seen);
		if (transformedItem !== OMIT_JSON_VALUE) {
			Object.defineProperty(transformed, key, {
				configurable: true,
				enumerable: true,
				value: transformedItem,
				writable: true,
			});
		}
	}
	seen.delete(value);
	return transformed;
}

function hasJsonSerializer(value: object): value is { toJSON: (key: string) => unknown } {
	return "toJSON" in value && typeof value.toJSON === "function";
}
