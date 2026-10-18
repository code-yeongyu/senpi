/**
 * WHICH CLI entry a supervisor re-enters for its host child (source tree, built dist, or a bundled
 * runtime snapshot's declared bin). Split out of `host-lifecycle-launch.ts` (senpi#2566); it stays in
 * this directory so `import.meta.url` resolves relative paths exactly as before.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isBundledNode } from "../../config.ts";

/**
 * Resolves the committed CLI entry this supervisor wraps (source tree or built dist).
 * Exported for tests, which pass the module path and layout of a bundled install.
 */
export function resolveCliMainPath(
	modulePath: string = fileURLToPath(import.meta.url),
	bundled: boolean = isBundledNode,
): string {
	// Bundled, take the entry from the package's own declared bin: the bundle's cli.js beside
	// this chunk, so a host started from a runtime snapshot runs the snapshot's copy and claims
	// it the way a session does (#2409). Counting ".." instead lands on dist/cli-main.js, the
	// unbundled tree the package also ships, which a snapshot links back to the install that an
	// upgrade replaces, or on the package root, where no cli-main was ever emitted.
	const declared = bundled ? resolveDeclaredCliEntry(modulePath) : undefined;
	if (declared !== undefined) return declared;
	const extension = modulePath.endsWith(".ts") ? ".ts" : ".js";
	const unbundled = resolve(dirname(modulePath), "..", "..", `cli-main${extension}`);
	if (existsSync(unbundled)) return unbundled;
	// Falls back to the old path when nothing is declared, so a caller that was working keeps working.
	return resolveDeclaredCliEntry(modulePath) ?? unbundled;
}

/** The CLI entry declared by the nearest enclosing package.json, when it exists on disk. */
function resolveDeclaredCliEntry(modulePath: string): string | undefined {
	let dir = dirname(modulePath);
	for (let depth = 0; depth < 8; depth += 1) {
		const manifestPath = resolve(dir, "package.json");
		if (existsSync(manifestPath)) {
			try {
				const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
					bin?: Record<string, string> | string;
				};
				const declared = manifest.bin;
				const candidates = typeof declared === "string" ? [declared] : Object.values(declared ?? {});
				for (const candidate of candidates) {
					const entry = resolve(dir, candidate);
					if (existsSync(entry)) return entry;
				}
			} catch {}
			return undefined;
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
	return undefined;
}
