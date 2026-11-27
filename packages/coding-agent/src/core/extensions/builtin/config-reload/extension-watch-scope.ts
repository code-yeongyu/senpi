import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { isExtensionSource } from "../../extension-source.ts";

const SUBDIRECTORY_ENTRY_NAMES = ["index.ts", "index.js", "package.json"] as const;

function isWithinPackage(relativePath: string): boolean {
	return relativePath !== "" && !relativePath.startsWith("..") && !relativePath.startsWith(sep);
}

/**
 * Paths a one-level extension package declares through `pi.extensions`, which
 * `resolveExtensionEntries` in `../../loader.ts` resolves relative to the
 * package directory and at any depth.
 */
function manifestEntryPaths(extensionsDir: string, packageName: string): string[] {
	const packageDir = join(extensionsDir, packageName);
	const packageJsonPath = join(packageDir, "package.json");
	if (!existsSync(packageJsonPath)) return [];
	try {
		const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
		if (typeof parsed !== "object" || parsed === null) return [];
		const pi: unknown = (parsed as { pi?: unknown }).pi;
		if (typeof pi !== "object" || pi === null) return [];
		const declared: unknown = (pi as { extensions?: unknown }).extensions;
		if (!Array.isArray(declared)) return [];
		return declared
			.filter((entry): entry is string => typeof entry === "string")
			.map((entry) => relative(extensionsDir, resolve(packageDir, entry)))
			.filter(isWithinPackage);
	} catch {
		return [];
	}
}

/**
 * Mirrors `discoverExtensionsInDir` in `../../loader.ts`, which never recurses
 * past one level except through a package manifest. Anything else is extension
 * runtime state, not configuration: the goal extension persists
 * `extensions/goal/<scope>/<id>.json`, and watching it turned every goal tool
 * call into a full session reload.
 */
export function isLoadableExtensionEntry(extensionsDir: string, relativePath: string): boolean {
	const segments = relativePath.split(sep).filter((segment) => segment !== "");
	const [first, second] = segments;
	if (first === undefined) return false;
	if (segments.length === 1) return isExtensionSource(first);
	if (segments.length === 2 && SUBDIRECTORY_ENTRY_NAMES.some((entryName) => entryName === second)) {
		return true;
	}
	return manifestEntryPaths(extensionsDir, first).includes(relativePath);
}

/**
 * Directories worth descending into while scanning. A manifest can declare an
 * entry at any depth, so every directory inside a package that declares one
 * stays scannable.
 */
export function isScannableExtensionDirectory(extensionsDir: string, relativePath: string): boolean {
	if (relativePath === "") return true;
	const segments = relativePath.split(sep).filter((segment) => segment !== "");
	const [first] = segments;
	if (first === undefined) return false;
	if (segments.length === 1) return true;
	return manifestEntryPaths(extensionsDir, first).some(
		(entryPath) => entryPath === relativePath || entryPath.startsWith(`${relativePath}${sep}`),
	);
}
