import { isBigIntObject, isBooleanObject, isNumberObject, isStringObject } from "node:util/types";

/** JSON.stringify's value semantics, without serializing or parsing a record. */
export function normalizeJsonValue(input: unknown): { value: unknown; changed: boolean } {
	const ancestors = new Set<object>();
	let changed = false;
	const visit = (input: unknown, key: string): unknown => {
		let value = input;
		if ((typeof value === "object" && value !== null) || typeof value === "function" || typeof value === "bigint") {
			const toJSON = (value as { toJSON?: (key: string) => unknown }).toJSON;
			if (typeof toJSON === "function") {
				value = toJSON.call(value, key);
				changed = true;
			}
		}
		if (typeof value === "object" && value !== null) {
			if (isNumberObject(value)) {
				value = +(value as unknown as number);
				changed = true;
			} else if (isStringObject(value)) {
				value = String(value);
				changed = true;
			} else if (isBooleanObject(value)) {
				value = Boolean.prototype.valueOf.call(value);
				changed = true;
			} else if (isBigIntObject(value)) {
				throw new TypeError("Do not know how to serialize a BigInt");
			}
		}
		if (typeof value === "bigint") throw new TypeError("Do not know how to serialize a BigInt");
		if (typeof value === "number") {
			const normalized = Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : null;
			if (!Object.is(normalized, value)) changed = true;
			return normalized;
		}
		if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
			changed = true;
			return undefined;
		}
		if (typeof value !== "object" || value === null) return value;
		if (ancestors.has(value)) throw new TypeError("Converting circular structure to JSON");
		ancestors.add(value);
		try {
			// A non-callable toJSON getter must not be read again by later serialization.
			if ("toJSON" in value) changed = true;
			if (Array.isArray(value)) {
				const array: unknown[] = [];
				const length = value.length;
				for (let index = 0; index < length; index++) {
					const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
					if (!descriptor || descriptor.get) changed = true;
					array.push(visit(value[index], String(index)) ?? null);
				}
				return array;
			}
			const result: Record<string, unknown> = {};
			const names = Object.keys(value);
			if (Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== names.length)
				changed = true;
			for (const name of names) {
				if (Object.getOwnPropertyDescriptor(value, name)?.get) changed = true;
				const child = visit((value as Record<string, unknown>)[name], name);
				if (child !== undefined)
					Object.defineProperty(result, name, {
						value: child,
						enumerable: true,
						configurable: true,
						writable: true,
					});
			}
			return result;
		} finally {
			ancestors.delete(value);
		}
	};
	let value: unknown;
	try {
		value = visit(input, "");
	} catch (error) {
		// The recursive walk overflows the stack before native JSON does; let native JSON decide.
		if (!(error instanceof RangeError)) throw error;
		return { value: JSON.parse(JSON.stringify(input)), changed: true };
	}
	if (value === undefined) throw new SyntaxError("JSON input has no representation");
	return { value, changed };
}
