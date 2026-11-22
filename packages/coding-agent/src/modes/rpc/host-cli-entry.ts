/**
 * WHICH CLI entry a supervisor re-enters for its host child (source tree, built dist, or a bundled
 * runtime snapshot's declared bin). Split out of `host-lifecycle-launch.ts` (senpi#2566); it stays in
 * this directory so `import.meta.url` resolves relative paths exactly as before.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isBundledNode } from "../../config.ts";

/** Whether this source module is the process entry, including a symlinked argv path. */
export function isCliModuleEntry(moduleUrl: string): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return fileURLToPath(moduleUrl) === realpathSync(entry);
	} catch {
		return false;
	}
}

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

const existsAsync = (path: string): Promise<boolean> =>
	access(path).then(
		() => true,
		() => false,
	);

/**
 * `resolveCliMainPath` without blocking the event loop: the per-session tool child (senpi#3566) resolves its entry on
 * the RPC session path, where a synchronous read is not allowed. Same decision, same order.
 */
export async function resolveCliMainPathAsync(
	modulePath: string = fileURLToPath(import.meta.url),
	bundled: boolean = isBundledNode,
): Promise<string> {
	const declared = bundled ? await resolveDeclaredCliEntryAsync(modulePath) : undefined;
	if (declared !== undefined) return declared;
	const extension = modulePath.endsWith(".ts") ? ".ts" : ".js";
	const unbundled = resolve(dirname(modulePath), "..", "..", `cli-main${extension}`);
	if (await existsAsync(unbundled)) return unbundled;
	return (await resolveDeclaredCliEntryAsync(modulePath)) ?? unbundled;
}

async function resolveDeclaredCliEntryAsync(modulePath: string): Promise<string | undefined> {
	let dir = dirname(modulePath);
	for (let depth = 0; depth < 8; depth += 1) {
		const manifestPath = resolve(dir, "package.json");
		if (await existsAsync(manifestPath)) {
			try {
				const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
					bin?: Record<string, string> | string;
				};
				const declaredBin = manifest.bin;
				const candidates = typeof declaredBin === "string" ? [declaredBin] : Object.values(declaredBin ?? {});
				for (const candidate of candidates) {
					const entry = resolve(dir, candidate);
					if (await existsAsync(entry)) return entry;
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
