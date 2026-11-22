#!/usr/bin/env node

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const [outputRootArgument, manifestPathArgument] = process.argv.slice(2);
if (!outputRootArgument) {
	throw new Error("Usage: copy-codemode-sidecar.mjs <binary-output-root> [manifest-path]");
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const manifestPath = resolve(manifestPathArgument ?? join(repoRoot, "packages", "senpi-codemode", "package.json"));
const sourceRoot = dirname(manifestPath);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
// Parse the loader's table without importing its entire runtime graph during packaging.
// Package roots include all virtual subpaths; host-only dependency trees are never walked.
const loaderPath = join(repoRoot, "packages", "coding-agent", "src", "core", "extensions", "loader.ts");
const virtualTable = readFileSync(loaderPath, "utf8").match(/const VIRTUAL_MODULES:[^{]+\{([\s\S]*?)\n\};/);
if (!virtualTable) {
	throw new Error(`Unable to read VIRTUAL_MODULES from ${loaderPath}`);
}
const HOST_PROVIDED_MODULES = new Set(
	Array.from(virtualTable[1].matchAll(/^\s*(?:"([^"]+)"|([\w$]+)):\s*/gm), (match) => {
		const specifier = match[1] ?? match[2];
		return specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
	}),
);
const targetRoot = join(
	resolve(outputRootArgument),
	"node_modules",
	"@code-yeongyu",
	"senpi-codemode",
);
const sidecarNodeModulesRoot = join(resolve(outputRootArgument), "node_modules");

if (!Array.isArray(manifest.files)) {
	throw new Error(`${manifestPath} must declare a files array`);
}

const outputRoot = resolve(outputRootArgument);
if (existsSync(join(outputRoot, "package.json"))) {
	throw new Error(`Refusing codemode sidecar output in a package root: ${outputRoot}`);
}
// Every path the copier removes or writes stays inside the output root: a symlinked
// segment (node_modules, a scope, or the package itself) would redirect it elsewhere.
function assertUnlinkedOutputPath(path) {
	let current = outputRoot;
	for (const segment of relative(outputRoot, path).split(sep)) {
		current = join(current, segment);
		const entry = lstatSync(current, { throwIfNoEntry: false });
		if (!entry) {
			return;
		}
		if (entry.isSymbolicLink()) {
			throw new Error(`Refusing to follow a symlinked codemode sidecar output path: ${current}`);
		}
	}
}
const ownershipPath = join(outputRoot, ".codemode-sidecar.json");
const journalExists = existsSync(ownershipPath);
const ownedPaths = journalExists ? JSON.parse(readFileSync(ownershipPath, "utf8")) : [];
for (const path of ownedPaths) {
	if (typeof path !== "string" || !path.startsWith(`node_modules${sep}`) || path.split(sep).includes("..")) {
		throw new Error("Invalid codemode sidecar ownership path");
	}
	assertUnlinkedOutputPath(join(outputRoot, path));
}
assertUnlinkedOutputPath(targetRoot);
// Before ownership journals existed, the copier staged only the extension with its parser nested inside.
function isJournalLessCopierLayout() {
	const stagedManifestPath = join(targetRoot, "package.json");
	return !journalExists
		&& existsSync(stagedManifestPath)
		&& JSON.parse(readFileSync(stagedManifestPath, "utf8")).name === "@code-yeongyu/senpi-codemode"
		&& existsSync(join(targetRoot, "node_modules", "@babel", "parser", "package.json"));
}
const targetRootOwned = ownedPaths.includes(relative(outputRoot, targetRoot)) || isJournalLessCopierLayout();
if (existsSync(targetRoot) && !targetRootOwned) {
	throw new Error(`Refusing to overwrite unowned codemode sidecar package at ${targetRoot}`);
}
for (const path of ownedPaths) {
	rmSync(join(outputRoot, path), { recursive: true, force: true });
}
rmSync(targetRoot, { recursive: true, force: true });
mkdirSync(targetRoot, { recursive: true });
const stagedPaths = [relative(outputRoot, targetRoot)];
writeFileSync(ownershipPath, JSON.stringify(stagedPaths));
cpSync(realpathSync(manifestPath), join(targetRoot, "package.json"), { dereference: true });

for (const entry of manifest.files) {
	if (typeof entry !== "string" || isAbsolute(entry)) {
		throw new Error(`Invalid codemode package file entry: ${JSON.stringify(entry)}`);
	}
	const normalizedEntry = normalize(entry);
	if (normalizedEntry === ".." || normalizedEntry.startsWith(`..${sep}`)) {
		throw new Error(`Codemode package file escapes its source root: ${entry}`);
	}
	const sourcePath = join(sourceRoot, normalizedEntry);
	if (!existsSync(sourcePath)) {
		throw new Error(`Codemode package file does not exist: ${sourcePath}`);
	}
	cpSync(sourcePath, join(targetRoot, normalizedEntry), { recursive: true, dereference: true });
}

const excludedPackage = process.env.SENPI_SIDECAR_EXCLUDE;
const copiedPackages = new Map();
const edges = [];
const pendingPackages = [];
function enqueueDependencies(packageManifest, sourceManifest, targetManifest) {
	for (const packageName of new Set([
		...Object.keys(packageManifest.dependencies ?? {}),
		...Object.keys(packageManifest.optionalDependencies ?? {}),
	])) {
		pendingPackages.push([packageName, sourceManifest, targetManifest, packageName in (packageManifest.optionalDependencies ?? {})]);
	}
}
enqueueDependencies(manifest, manifestPath, join(targetRoot, "package.json"));

function resolvePackageManifest(packageName, requiringManifestPath, optional = false) {
	const require = createRequire(requiringManifestPath);
	try {
		return require.resolve(`${packageName}/package.json`);
	} catch (error) {
if (optional && error instanceof Error && error.code === "MODULE_NOT_FOUND") {
			return undefined;
		}
		if (!(error instanceof Error) || error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") {
			throw new Error(`Unable to resolve codemode sidecar dependency ${packageName}`, { cause: error });
		}
		for (const searchRoot of require.resolve.paths(packageName) ?? []) {
			const candidate = join(searchRoot, packageName, "package.json");
			if (existsSync(candidate)) {
				return candidate;
			}
		}
		throw new Error(`Unable to resolve codemode sidecar dependency ${packageName}`, { cause: error });
	}
}

while (pendingPackages.length > 0) {
	const [packageName, requiringManifestPath, requiringTargetManifestPath, optional] = pendingPackages.pop();
	if (HOST_PROVIDED_MODULES.has(packageName) || packageName === excludedPackage) {
		continue;
	}

	const resolvedManifest = resolvePackageManifest(packageName, requiringManifestPath, optional);
	if (!resolvedManifest) {
		continue;
	}
	const packageManifestPath = realpathSync(resolvedManifest);
	const packageRoot = dirname(packageManifestPath);
	// Preserve the full source nesting, independent of traversal order. Workspace
	// roots outside node_modules use the root slot; the edge audit rejects conflicts.
	const modulesMarker = `${sep}node_modules${sep}`;
	const modulesIndex = packageRoot.indexOf(modulesMarker);
	const packageTarget = modulesIndex < 0
		? join(sidecarNodeModulesRoot, packageName)
		: join(sidecarNodeModulesRoot, packageRoot.slice(modulesIndex + modulesMarker.length));
	edges.push([packageName, requiringTargetManifestPath, packageRoot]);
	if (copiedPackages.get(packageTarget) === packageRoot) {
		continue;
	}
	if (copiedPackages.has(packageTarget)) {
		throw new Error(`Conflicting codemode sidecar dependency ${packageName} at ${packageTarget}`);
	}
	assertUnlinkedOutputPath(packageTarget);
	if (existsSync(packageTarget)) {
		throw new Error(`Refusing to overwrite unowned codemode sidecar dependency ${packageName}`);
	}
	const packageManifest = JSON.parse(readFileSync(packageManifestPath, "utf8"));
	stagedPaths.push(relative(outputRoot, packageTarget));
	writeFileSync(ownershipPath, JSON.stringify(stagedPaths));
	cpSync(packageRoot, packageTarget, {
		recursive: true,
		dereference: true,
		filter: (sourcePath) => sourcePath !== join(packageRoot, "node_modules"),
	});
	copiedPackages.set(packageTarget, packageRoot);
	enqueueDependencies(packageManifest, packageManifestPath, join(packageTarget, "package.json"));
}

for (const [packageName, targetManifest, sourcePackageRoot] of edges) {
	const stagedManifest = resolvePackageManifest(packageName, targetManifest);
	const stagedPath = resolve(outputRoot, relative(realpathSync(outputRoot), dirname(realpathSync(stagedManifest))));
	if (copiedPackages.get(stagedPath) !== sourcePackageRoot) {
		throw new Error(`Conflicting codemode sidecar dependency ${packageName} required by ${targetManifest}`);
	}
}

console.log(
	`[copy-codemode-sidecar] copied ${manifest.files.length} entries and ${copiedPackages.size} runtime packages to ${targetRoot}`,
);
