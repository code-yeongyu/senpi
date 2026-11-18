// Realm census (design #12965, 3.3): the root set. Every workspace package whose code runs in the engine realm is a
// root: coding-agent's workspace dependency closure (static, dynamic and string references to workspace package names,
// followed transitively) plus the engine-owned extension packages in
// packages/coding-agent/src/core/bundled-resources.ts and their own workspace references. Build output is not read.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseFile, sourceFiles, walk } from "./realm-census-source.mjs";

const START_PACKAGE = "coding-agent";
const BUNDLED_RESOURCES = "packages/coding-agent/src/core/bundled-resources.ts";
const BUNDLED_TABLE = "bundledBuiltinExtensions";
const TYPE_NODES = new Set(["TSTypeAliasDeclaration", "TSInterfaceDeclaration", "TSDeclareFunction", "TSImportType"]);

/** Workspace package name -> directory under packages/ (nested session backends included). */
function workspacePackages(root) {
	const packagesDir = join(root, "packages");
	const byName = new Map();
	const consider = (dir) => {
		const manifest = join(packagesDir, dir, "package.json");
		if (!existsSync(manifest)) return false;
		const name = JSON.parse(readFileSync(manifest, "utf8")).name;
		if (typeof name === "string") byName.set(name, dir);
		return true;
	};
	for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (consider(entry.name)) continue;
		for (const nested of readdirSync(join(packagesDir, entry.name), { withFileTypes: true })) {
			if (nested.isDirectory()) consider(`${entry.name}/${nested.name}`);
		}
	}
	return byName;
}

function packageOfSpecifier(specifier, byName) {
	for (const [name, dir] of byName) if (specifier === name || specifier.startsWith(`${name}/`)) return dir;
	return undefined;
}

/** Workspace packages a package references at run time: imports, dynamic imports, re-exports and plain strings. */
function referencedPackages(root, dir, byName) {
	const found = new Set();
	for (const file of sourceFiles(join(root, "packages", dir, "src"))) {
		walk(parseFile(file).program, (node) => {
			if (TYPE_NODES.has(node.type)) return false;
			if (node.type === "ImportDeclaration") {
				const typeOnly =
					node.importKind === "type" ||
					(node.specifiers.length > 0 && node.specifiers.every((specifier) => specifier.importKind === "type"));
				if (typeOnly) return false;
			}
			if (
				(node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") &&
				node.exportKind === "type"
			) {
				return false;
			}
			const text =
				node.type === "Literal" && typeof node.value === "string"
					? node.value
					: node.type === "TemplateLiteral" && node.expressions.length === 0
						? node.quasis[0]?.value.cooked
						: undefined;
			if (text !== undefined) {
				const target = packageOfSpecifier(text, byName);
				if (target !== undefined && target !== dir) found.add(target);
			}
			return true;
		});
	}
	return found;
}

/** Source 3: the engine-owned extension packages the loader resolves by name. */
function bundledExtensionPackages(root, byName) {
	const file = join(root, BUNDLED_RESOURCES);
	if (!existsSync(file))
		throw new Error(`${BUNDLED_RESOURCES} is missing; the engine-owned extension table cannot be read`);
	let table;
	walk(parseFile(file).program, (node) => {
		if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.id.name === BUNDLED_TABLE)
			table = node.init;
		return table === undefined;
	});
	if (!table) throw new Error(`${BUNDLED_RESOURCES} no longer declares ${BUNDLED_TABLE}`);
	const found = new Set();
	walk(table, (node) => {
		if (node.type === "Literal" && typeof node.value === "string") {
			const target = packageOfSpecifier(node.value, byName);
			if (target !== undefined) found.add(target);
		}
		return true;
	});
	return found;
}

/**
 * Derive the root set. `dropRoots` exists only for the census test's M12 mutant: it removes a package from the
 * derivation, which must then disagree with the checked-in list.
 */
export function deriveRoots(root, { dropRoots = [] } = {}) {
	const byName = workspacePackages(root);
	const dropped = new Set(dropRoots);
	const roots = new Set();
	const queue = [START_PACKAGE, ...bundledExtensionPackages(root, byName)];
	while (queue.length > 0) {
		const dir = queue.shift();
		if (roots.has(dir) || dropped.has(dir)) continue;
		roots.add(dir);
		for (const next of referencedPackages(root, dir, byName)) if (!roots.has(next)) queue.push(next);
	}
	return [...roots].sort();
}
