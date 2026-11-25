import type { StoreValue } from "../durable/store.ts";

/**
 * The canonical JSON of a store value: object keys sorted by UTF-16 code unit, no whitespace. Every execution digest
 * (a batch manifest, a call's request, a frozen call, a tool schema) hashes this form, so two sides that build the same
 * value agree on its digest.
 */
export function canonicalJson(value: StoreValue): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonicalJson(inner)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

/** Lower-case hex SHA-256 of {@link canonicalJson}, through Web Crypto so the agent loop stays browser-safe. */
export async function canonicalDigest(value: StoreValue): Promise<string> {
	const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
	return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
