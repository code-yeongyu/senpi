#!/usr/bin/env node
// Parsing helpers for scripts/qa/fork-preservation-check.mjs.
// Source-level only (no TypeScript compile, no dependencies): the fork
// invariants must be checkable on an unbuilt tree, including a mid-merge one.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function readIfExists(path) {
	return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** Names exported by `export { a, type b, c as d }` / `export type { ... }` lists. */
function exportListNames(source) {
	const names = new Set();
	for (const match of source.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}/g)) {
		for (const raw of match[1].split(",")) {
			const entry = raw.trim().replace(/^type\s+/, "");
			if (entry === "") continue;
			const aliased = entry.match(/^\S+\s+as\s+(\S+)$/);
			names.add(aliased ? aliased[1] : entry);
		}
	}
	return names;
}

/** True when `name` is exported by this file's own declarations or export lists. */
export function declaresExport(source, name) {
	const declaration = new RegExp(
		`^export\\s+(?:declare\\s+)?(?:async\\s+)?(?:function\\*?|const|let|var|class|abstract\\s+class|type|interface|enum)\\s+${name}\\b`,
		"m",
	);
	return declaration.test(source) || exportListNames(source).has(name);
}

function starReexportTargets(source) {
	return [...source.matchAll(/\bexport\s+\*\s+from\s+["']([^"']+)["']/g)].map((match) => match[1]);
}

/**
 * True when `file` exports `name` directly or through one of its own
 * `export * from "./x.ts"` re-exports (one hop - deeper chains are not fork
 * invariants and following them would let an unrelated module mask a drop).
 */
export function sourceExportsSymbol(file, name) {
	const source = readIfExists(file);
	if (source === null) return false;
	if (declaresExport(source, name)) return true;
	for (const target of starReexportTargets(source)) {
		if (!target.startsWith(".")) continue;
		const resolved = readIfExists(resolve(dirname(file), target));
		if (resolved !== null && declaresExport(resolved, name)) return true;
	}
	return false;
}

/**
 * Top-level keys of the object literal that starts at `marker` (quoted or bare
 * identifier keys, brace-depth aware). Returns null when the marker is absent.
 */
export function objectLiteralKeys(source, marker) {
	const start = source.indexOf(marker);
	if (start < 0) return null;
	const open = source.indexOf("{", start);
	if (open < 0) return null;
	const keys = [];
	let depth = 0;
	for (const line of source.slice(open).split("\n")) {
		const depthAtLineStart = depth;
		for (const char of line) {
			if (char === "{") depth += 1;
			else if (char === "}") depth -= 1;
		}
		if (depthAtLineStart === 1) {
			const key = line.match(/^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*:/);
			if (key) keys.push(key[1] ?? key[2] ?? key[3]);
		}
		if (depth === 0 && depthAtLineStart > 0) break;
	}
	return keys;
}

/**
 * String entries of the array literal assigned to the first identifier matching
 * `identifier` (e.g. `const EXPECTED_SENPI_LOADER_ALIASES = [ "a", "b" ] as const`).
 */
export function stringArrayLiteral(source, identifier) {
	const start = source.search(new RegExp(`\\b[\\w$]*${identifier}[\\w$]*\\b\\s*(?::[^=]*)?=\\s*\\[`));
	if (start < 0) return null;
	const open = source.indexOf("[", start);
	const close = source.indexOf("]", open);
	if (open < 0 || close < 0) return null;
	return [...source.slice(open + 1, close).matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
}

/** Quoted strings on the statement that declares `identifier`. */
export function quotedStringsInStatement(source, identifier) {
	const start = source.indexOf(identifier);
	if (start < 0) return null;
	const end = source.indexOf(";", start);
	const statement = source.slice(start, end < 0 ? source.length : end);
	return [...statement.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
}

/** Root plus workspace manifests, two levels deep (packages/session-backends/*). */
export function packageManifests(root) {
	const manifests = [];
	if (existsSync(join(root, "package.json"))) manifests.push("package.json");
	const walk = (relative, depth) => {
		const absolute = join(root, relative);
		if (!existsSync(absolute)) return;
		for (const entry of readdirSync(absolute, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name === "node_modules") continue;
			const child = `${relative}/${entry.name}`;
			if (existsSync(join(root, child, "package.json"))) manifests.push(`${child}/package.json`);
			if (depth > 0) walk(child, depth - 1);
		}
	};
	walk("packages", 1);
	return manifests;
}

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "overrides"];

/** Every declared version of `name` across the dependency maps of one manifest. */
export function dependencyVersions(manifest, name) {
	const found = [];
	for (const field of DEPENDENCY_FIELDS) {
		const map = manifest?.[field];
		if (!map || typeof map !== "object") continue;
		const version = map[name];
		if (typeof version === "string") found.push({ field, version });
	}
	return found;
}

/** Flattened `<provider>/<modelId>` rows of packages/ai/src/providers/data/*.json. */
export function modelCatalogRows(dataDir) {
	const rows = [];
	for (const file of readdirSync(dataDir).sort()) {
		if (!file.endsWith(".json")) continue;
		const parsed = JSON.parse(readFileSync(join(dataDir, file), "utf8"));
		for (const [provider, models] of Object.entries(parsed)) {
			if (!models || typeof models !== "object") continue;
			for (const [id, model] of Object.entries(models)) {
				if (!model || typeof model !== "object") continue;
				rows.push({ file, provider, id, contextWindow: model.contextWindow });
			}
		}
	}
	return rows;
}
