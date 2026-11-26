const identityField = /^(?:signing|sealing|ek|sk)$/;
const encoded32 = /^[A-Za-z0-9+/_-]{43}$/;
const marker = "[REDACTED]";

function redactText(text: string): string {
	if (!/^\s*[[{]/.test(text)) return text;
	let changed = false;
	try {
		const json: unknown = JSON.parse(text, (key: string, value: unknown) => {
			if (identityField.test(key) && typeof value === "string" && encoded32.test(value)) {
				changed = true;
				return marker;
			}
			return value;
		});
		return changed ? JSON.stringify(json) : text;
	} catch {
		return text;
	}
}

// Results may carry non-JSON metadata. Leave opaque objects alone, and retain
// the original result (including formatting of serialized JSON) when nothing matched.
function redact(value: unknown, ancestors: Set<object>): unknown {
	if (typeof value === "string") return redactText(value);
	if (value === null || typeof value !== "object" || ancestors.has(value)) return value;
	const array = Array.isArray(value);
	const proto: unknown = Object.getPrototypeOf(value);
	if (!array && proto !== Object.prototype && proto !== null) return value;
	ancestors.add(value);
	let copy: Record<string, unknown> | unknown[] | undefined;
	for (const [key, child] of Object.entries(value)) {
		const next =
			identityField.test(key) && typeof child === "string" && encoded32.test(child)
				? marker
				: redact(child, ancestors);
		if (next === child) continue;
		copy ??= array ? [...value] : { ...value };
		Object.defineProperty(copy, key, { value: next, enumerable: true, configurable: true, writable: true });
	}
	ancestors.delete(value);
	return copy ?? value;
}

export function redactIdentityOutput<T>(value: T): T {
	// Only string values are replaced with strings at the same positions.
	return redact(value, new Set()) as T;
}
