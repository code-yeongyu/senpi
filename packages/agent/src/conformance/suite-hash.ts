export interface SuiteHashEntry {
	readonly id: string;
	readonly impl_hash: string;
}

/** Lower-case hex SHA-256 through Web Crypto, so the same code runs on Bun, Node and a Durable Object. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The suite hash: SHA-256 over one `id<TAB>impl_hash` line per case, sorted by ID. It changes when a case is added,
 * removed or renamed, or when any case implementation changes, and never with registration order.
 */
export async function computeSuiteHash(entries: readonly SuiteHashEntry[]): Promise<string> {
	const ids = new Set<string>();
	for (const { id } of entries) {
		if (ids.has(id)) throw new Error(`duplicate conformance case ID in the suite hash: ${id}`);
		ids.add(id);
	}
	const lines = entries.map(({ id, impl_hash }) => `${id}\t${impl_hash}\n`).sort();
	return sha256Hex(new TextEncoder().encode(lines.join("")));
}
