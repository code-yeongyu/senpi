import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type PreparedEdge = { readonly specifier: string; readonly id: string; readonly commonJs: boolean };

/**
 * An extension module's prepared source with its generation left as `token`, so one entry serves
 * every importer generation. `edges` and `esmByType` are the filesystem facts the bytes depend on;
 * a hit is only trusted after the importer re-checks them.
 */
export type PreparedSource = {
	readonly token: string;
	readonly contents: string;
	readonly commonJs: boolean;
	readonly esmByType: boolean;
	readonly edges: readonly PreparedEdge[];
};

type Entry = PreparedSource & { readonly key: string; readonly fingerprint: string };

// Entries are keyed by path, so stale ones only pile up when extensions move (a runtime update
// installs a new path). A real extension graph has thousands of modules, so the bound is age, not
// count: an entry nobody rewrote for this long is removed, and a still-used one is simply rebuilt.
const MAX_ENTRY_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function isPreparedSource(value: unknown): value is Entry {
	if (typeof value !== "object" || value === null) return false;
	const field = (name: string) => typeof Reflect.get(value, name);
	return (
		field("key") === "string" &&
		field("fingerprint") === "string" &&
		field("token") === "string" &&
		field("contents") === "string" &&
		field("commonJs") === "boolean" &&
		field("esmByType") === "boolean" &&
		Array.isArray(Reflect.get(value, "edges"))
	);
}

function prune(directory: string): void {
	const cutoff = Date.now() - MAX_ENTRY_AGE_MS;
	for (const name of readdirSync(directory)) {
		const path = join(directory, name);
		if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
	}
}

/**
 * Disk cache of the importer's transpile + import-rewrite output, so a fresh host skips that work
 * for unchanged sources. `keyParts` is everything outside the source that shapes the output, as the
 * importer passes it (release version, Bun version, runtime module path, extension namespace and the source
 * of the code that prepares the bytes); `fingerprint` is the source hash.
 * A miss, a corrupt entry and an unwritable directory all mean "prepare it again": the cache only
 * ever saves time, so its I/O failures never reach the extension load.
 */
export function createPreparedSourceCache(directory: string, keyParts: readonly string[]) {
	const key = sha256(keyParts.join("\0"));
	const entryPath = (filename: string) => join(directory, `${sha256(filename).slice(0, 40)}.json`);
	let pruned = false;
	return {
		read(filename: string, fingerprint: string): PreparedSource | undefined {
			let parsed: unknown;
			try {
				parsed = JSON.parse(readFileSync(entryPath(filename), "utf8"));
			} catch {
				return undefined;
			}
			if (!isPreparedSource(parsed) || parsed.key !== key || parsed.fingerprint !== fingerprint) return undefined;
			return parsed;
		},
		write(filename: string, fingerprint: string, prepared: PreparedSource): void {
			const target = entryPath(filename);
			const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
			try {
				mkdirSync(directory, { recursive: true });
				writeFileSync(temporary, JSON.stringify({ ...prepared, key, fingerprint } satisfies Entry));
				renameSync(temporary, target);
				if (!pruned) {
					pruned = true;
					prune(directory);
				}
			} catch {
				rmSync(temporary, { force: true });
			}
		},
	};
}
