import { readFileSync, realpathSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// A cell's bare import runs `import()` from this worker's own module, so the runtime resolves it from Senpi's install
// tree, not the session's project or its managed package revision. This resolver walks `node_modules` from each root
// the cell names, in order, and resolves the package entry the way ESM does (the `exports` field with import
// conditions), so ESM-only packages load and the first root that has the package wins.
const RESOLVE_PACKAGE = Symbol.for("senpi.kernel.resolvePackage");
const CONDITIONS = typeof globalThis.Bun === "object" ? ["bun", "node", "import", "default"] : ["node", "import", "default"];

function isFile(path) {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function isDirectory(path) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function splitSpecifier(specifier) {
	const parts = specifier.split("/");
	const nameParts = specifier.startsWith("@") ? 2 : 1;
	if (parts.length < nameParts || parts.slice(0, nameParts).some((part) => part === "" || part === "." || part === ".."))
		return undefined;
	const rest = parts.slice(nameParts).join("/");
	return { name: parts.slice(0, nameParts).join("/"), subpath: rest === "" ? "." : `./${rest}` };
}

function conditionalTarget(target) {
	if (typeof target === "string") return target;
	if (Array.isArray(target)) {
		for (const candidate of target) {
			const resolved = conditionalTarget(candidate);
			if (resolved !== undefined) return resolved;
		}
		return undefined;
	}
	if (target === null || typeof target !== "object") return undefined;
	for (const [condition, value] of Object.entries(target)) {
		if (condition !== "default" && !CONDITIONS.includes(condition)) continue;
		const resolved = conditionalTarget(value);
		if (resolved !== undefined) return resolved;
	}
	return undefined;
}

function exportsTarget(exportsField, subpath) {
	const subpathKeyed =
		exportsField !== null &&
		typeof exportsField === "object" &&
		!Array.isArray(exportsField) &&
		Object.keys(exportsField).some((key) => key.startsWith("."));
	if (!subpathKeyed) return subpath === "." ? conditionalTarget(exportsField) : undefined;
	if (Object.hasOwn(exportsField, subpath)) return conditionalTarget(exportsField[subpath]);
	let best;
	for (const key of Object.keys(exportsField)) {
		const star = key.indexOf("*");
		if (star < 0 || key.includes("*", star + 1)) continue;
		const prefix = key.slice(0, star);
		const suffix = key.slice(star + 1);
		if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix) || subpath.length < prefix.length + suffix.length)
			continue;
		if (best === undefined || prefix.length > best.prefix.length) {
			best = { key, prefix, match: subpath.slice(prefix.length, subpath.length - suffix.length) };
		}
	}
	if (best === undefined || hasInvalidSegment(best.match)) return undefined;
	const target = conditionalTarget(exportsField[best.key]);
	return target === undefined ? undefined : target.replaceAll("*", best.match);
}

// Node refuses a pattern match or target with "." / ".." / "node_modules" segments (ERR_INVALID_MODULE_SPECIFIER).
function hasInvalidSegment(path) {
	return path.split(/[\\/]/).some((segment) => segment === "." || segment === ".." || segment === "node_modules");
}

function legacyFile(path) {
	for (const candidate of [path, `${path}.js`, `${path}.mjs`, `${path}.cjs`, join(path, "index.js")]) {
		if (isFile(candidate)) return candidate;
	}
	return undefined;
}

function packageEntry(packageDir, subpath, specifier) {
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	} catch {
		return legacyFile(join(packageDir, subpath === "." ? "index.js" : subpath));
	}
	if (manifest.exports !== undefined && manifest.exports !== null) {
		const target = exportsTarget(manifest.exports, subpath);
		if (typeof target !== "string" || !target.startsWith("./") || hasInvalidSegment(target.slice(2))) {
			const error = new Error(`Package subpath '${subpath}' is not exported for import by '${specifier}'`);
			error.code = "ERR_PACKAGE_PATH_NOT_EXPORTED";
			throw error;
		}
		return join(packageDir, target);
	}
	if (subpath !== ".") return legacyFile(join(packageDir, subpath));
	const moduleEntry = typeof globalThis.Bun === "object" && typeof manifest.module === "string" ? manifest.module : undefined;
	const main = moduleEntry ?? (typeof manifest.main === "string" ? manifest.main : "index.js");
	return legacyFile(join(packageDir, main));
}

function findPackageDir(name, rootUrl) {
	let directory = fileURLToPath(rootUrl);
	for (;;) {
		const candidate = join(directory, "node_modules", name);
		if (isDirectory(candidate)) return candidate;
		const parent = dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

/**
 * The file URL the bare `specifier` resolves to from the first of `rootUrls` whose `node_modules` chain has its
 * package, or undefined when it names a builtin or no root has the package (the caller then imports it natively).
 */
export function resolvePackage(specifier, rootUrls) {
	if (specifier.includes(":") || isBuiltin(specifier)) return undefined;
	const parts = splitSpecifier(specifier);
	if (parts === undefined) return undefined;
	for (const rootUrl of rootUrls) {
		if (typeof rootUrl !== "string") continue;
		const packageDir = findPackageDir(parts.name, rootUrl);
		if (packageDir === undefined) continue;
		const entry = packageEntry(packageDir, parts.subpath, specifier);
		if (entry === undefined) continue;
		let real = entry;
		try {
			real = realpathSync(entry);
		} catch {
			// A missing target fails in the import itself, with the runtime's own error.
		}
		return pathToFileURL(real.endsWith(sep) ? real.slice(0, -1) : real).href;
	}
	return undefined;
}

export function installPackageResolver() {
	globalThis[RESOLVE_PACKAGE] = resolvePackage;
}
