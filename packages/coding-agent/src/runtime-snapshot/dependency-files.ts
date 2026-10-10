import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const INERT_TREE = /^(?:tests?|__tests__|__fixtures__|fixtures|docs?|examples?|bench(?:marks?)?)$/;
const ROOT_NOTES = /^(?:readme|changelog|history)(?:\.[^/]*)?$/i;
const ROOT_MARKDOWN = /^[^/]+\.md$/i;
const LICENSE = /^licen[cs]e(?:\.[^/]*)?$/i;

/**
 * Keep every package and its runtime assets, but not development payload. Manifest entry roots
 * override directory conventions; source-only extensions and skills remain intact. A source TS
 * tree is redundant only when the package actually has a built JS entry, and no entry names src.
 * This is deliberately not a runtime-path allowlist: a sampled run cannot prove an unvisited
 * provider or dynamic extension will never need a package (#2408).
 */
export function dependencyFileExclusions(packageDir: string): (path: string) => boolean {
	const manifest: unknown = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	if (typeof manifest !== "object" || manifest === null) return () => false;
	const entryRoots = new Set<string>();
	let built = false;
	const visit = (value: unknown): void => {
		if (typeof value === "string") {
			const entry = value.replace(/^\.\//, "");
			entryRoots.add(entry.split("/")[0] ?? "");
			if (/\.[cm]?js$/.test(entry) && existsSync(join(packageDir, entry))) built = true;
		} else if (Array.isArray(value)) {
			for (const child of value) visit(child);
		} else if (typeof value === "object" && value !== null) {
			for (const [condition, child] of Object.entries(value)) if (condition !== "types") visit(child);
		}
	};
	for (const [key, value] of Object.entries(manifest))
		if (["main", "module", "exports", "bin", "pi"].includes(key)) visit(value);
	return (path) => {
		const root = path.split("/")[0] ?? "";
		if (entryRoots.has(root) || entryRoots.has("*") || entryRoots.has("**")) return false;
		if (INERT_TREE.test(root) || ROOT_NOTES.test(path) || (ROOT_MARKDOWN.test(path) && !LICENSE.test(path)))
			return true;
		return built && root === "src" && /\.[cm]?tsx?$/.test(path);
	};
}
