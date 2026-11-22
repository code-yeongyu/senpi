import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Whether a bare import of `name` from the session directory resolves in the project before a managed revision: the
 * host-side twin of the kernel resolver (`kernels/js/worker-package-resolve.js` stays plain JavaScript, and a `.ts`
 * module may not import it). Like the resolver it stops at the first `node_modules/<name>` directory up the chain,
 * and that directory wins only when the resolver would take an entry from it.
 */
export function projectResolves(cwd: string, name: string): boolean {
	for (let directory = cwd; ; directory = dirname(directory)) {
		const packageDir = join(directory, "node_modules", name);
		if (isDirectory(packageDir)) return hasRootEntry(packageDir);
		if (dirname(directory) === directory) return false;
	}
}

function hasRootEntry(packageDir: string): boolean {
	let manifest: unknown;
	try {
		manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	} catch {
		return legacyFile(join(packageDir, "index.js"));
	}
	// The resolver throws on a null manifest and treats any other non-object as one without fields.
	if (manifest === null) return true;
	if (typeof manifest !== "object") return legacyFile(join(packageDir, "index.js"));
	// With `exports` the resolver commits to this package: it imports the "." target or fails, never falling through.
	if ("exports" in manifest && manifest.exports !== undefined && manifest.exports !== null) return true;
	const moduleEntry =
		"Bun" in globalThis && "module" in manifest && typeof manifest.module === "string" ? manifest.module : undefined;
	const main = "main" in manifest && typeof manifest.main === "string" ? manifest.main : "index.js";
	return legacyFile(join(packageDir, moduleEntry ?? main));
}

function legacyFile(path: string): boolean {
	return [path, `${path}.js`, `${path}.mjs`, `${path}.cjs`, join(path, "index.js")].some(isFile);
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
