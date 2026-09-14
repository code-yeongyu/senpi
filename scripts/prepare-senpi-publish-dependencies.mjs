#!/usr/bin/env node
// Stages the registry runtime closure of packages/coding-agent/publish-deps.lock.json into
// packages/coding-agent/node_modules so the packed tarball is self-contained. The staged
// tree mirrors the manifest exactly, whatever layout the developer's package manager
// produced: every entry lands at the placement resolvePublishPlacements() derives from the
// manifest (nested entries included) with the manifest version, and anything the manifest
// does not place is pruned.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { chainLockPath, resolvePublishPlacements } from "./prepare-senpi-publish-placements.mjs";
export { lockPathPackageChain } from "./prepare-senpi-publish-placements.mjs";

function listPackageDirectories(nodeModulesDir) {
	const packages = [];
	if (!existsSync(nodeModulesDir)) return packages;
	for (const entry of readdirSync(nodeModulesDir, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		if (entry.name.startsWith("@")) {
			const scopeDir = join(nodeModulesDir, entry.name);
			for (const scoped of readdirSync(scopeDir, { withFileTypes: true })) {
				if (scoped.isDirectory()) packages.push({ name: `${entry.name}/${scoped.name}`, path: join(scopeDir, scoped.name) });
			}
			continue;
		}
		packages.push({ name: entry.name, path: join(nodeModulesDir, entry.name) });
	}
	return packages;
}

// Only "no package here" is a non-match; a manifest that exists but cannot be read or
// parsed is a broken installation and surfaces as such.
function installedPackageMatches(packageDir, entry) {
	const manifestPath = join(packageDir, "package.json");
	let source;
	try {
		source = readFileSync(manifestPath, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
		throw error;
	}
	let installed;
	try {
		installed = JSON.parse(source);
	} catch (error) {
		throw new Error(`${manifestPath} is not valid JSON: ${error.message}`);
	}
	return typeof entry?.version !== "string" || installed.version === entry.version;
}

// The manifest is npm's standalone tree for coding-agent, while the developer's install is
// laid out by whichever package manager ran (bun hoists a workspace install by its own
// rules). A manifest entry may therefore sit at the same nesting under the root install, be
// hoisted to the root, be staged in place already (materialized optionals), or be nested
// under some other dependent. Take the first installed copy whose version matches the
// manifest; a copy of another version is never a substitute.
function locateInstalledPackage(repoRoot, chain, entry, targetPath) {
	const rootNodeModules = join(repoRoot, "node_modules");
	const name = chain[chain.length - 1];
	for (const candidate of [join(repoRoot, chainLockPath(chain)), join(rootNodeModules, name), targetPath]) {
		if (installedPackageMatches(candidate, entry)) return candidate;
	}
	const pending = [rootNodeModules];
	while (pending.length > 0) {
		const nodeModulesDir = pending.pop();
		const candidate = join(nodeModulesDir, name);
		if (installedPackageMatches(candidate, entry)) return candidate;
		for (const { path } of listPackageDirectories(nodeModulesDir)) {
			const nested = join(path, "node_modules");
			if (existsSync(nested)) pending.push(nested);
		}
	}
	return undefined;
}

// Anything in the staged tree that the manifest does not list is a leftover from an earlier
// dependency graph (or an installer-specific nesting) and would otherwise be packed and
// shadow the manifest's resolution. Internal workspaces are re-staged by
// prepareSenpiBundledWorkspaces and are left alone here.
function pruneUnlistedPackages(nodeModulesDir, manifestLockPaths, internalPackageNames, lockPrefix = "node_modules") {
	for (const { name, path } of listPackageDirectories(nodeModulesDir)) {
		if (lockPrefix === "node_modules" && internalPackageNames.has(name)) continue;
		const lockPath = `${lockPrefix}/${name}`;
		if (!manifestLockPaths.has(lockPath)) {
			rmSync(path, { recursive: true, force: true });
			continue;
		}
		pruneUnlistedPackages(join(path, "node_modules"), manifestLockPaths, internalPackageNames, `${lockPath}/node_modules`);
	}
	if (!existsSync(nodeModulesDir)) return;
	for (const entry of readdirSync(nodeModulesDir, { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.startsWith("@")) continue;
		const scopeDir = join(nodeModulesDir, entry.name);
		if (readdirSync(scopeDir).length === 0) rmSync(scopeDir, { recursive: true, force: true });
	}
}

function copyPackage(sourcePath, targetPath) {
	mkdirSync(dirname(targetPath), { recursive: true });
	// Only the package itself: whatever the installer nested inside it is its own placement,
	// not the manifest's, and would shadow the entries staged here.
	cpSync(sourcePath, targetPath, {
		recursive: true,
		filter: (source) => !relative(sourcePath, source).split(sep).includes("node_modules"),
	});
}

export function stagePublishDependencies(repoRoot, internalPackageNames) {
	// Staging manifest for the bundled publish tree. NOT npm-shrinkwrap.json: shipping a
	// file named npm-shrinkwrap.json breaks bundleDependencies installs (see the guard in
	// assertSenpiPackedWorkspaceFiles). Generated by generate-coding-agent-shrinkwrap.mjs.
	const manifestPath = join(repoRoot, "packages/coding-agent/publish-deps.lock.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const codingAgentDir = join(repoRoot, "packages/coding-agent");
	const codingAgentNodeModules = join(codingAgentDir, "node_modules");

	// Every source is located before anything is replaced: a child's only matching copy may
	// sit inside the parent about to be replaced (materialized optionals live there).
	const plan = [];
	for (const { lockPath, chain, entry } of resolvePublishPlacements(manifest.packages ?? {}, internalPackageNames)) {
		const optional = entry && typeof entry === "object" && entry.optional === true;
		const targetPath = join(codingAgentDir, lockPath);
		const sourcePath = locateInstalledPackage(repoRoot, chain, entry, targetPath);
		if (sourcePath === undefined) {
			// Nothing installed matches the manifest: a copy left at the target by an earlier
			// graph must not be packed as if it were this entry.
			rmSync(targetPath, { recursive: true, force: true });
			if (optional) continue;
			const expected = typeof entry?.version === "string" ? `@${entry.version}` : "";
			throw new Error(
				`Missing ${join(repoRoot, "node_modules", chain[chain.length - 1])}${expected} for ${lockPath}. Run npm install before publishing.`,
			);
		}
		plan.push({ lockPath, chain, optional, targetPath, sourcePath });
	}

	// Parent before child (placements come shallowest first), so a nested copy lands inside
	// the freshly staged parent. Replacing a parent would take the copies located inside it
	// with it, so those are set aside first and staged from there.
	const salvageRoot = mkdtempSync(join(tmpdir(), "senpi-publish-stage-"));
	try {
		for (const [index, step] of plan.entries()) {
			if (step.chain.length > 1 && !existsSync(join(codingAgentDir, chainLockPath(step.chain.slice(0, -1)), "package.json"))) {
				// The parent was optional and absent; its nested closure is absent with it.
				if (step.optional) continue;
				throw new Error(`Missing staged parent for ${step.lockPath}. Run npm install before publishing.`);
			}
			if (step.sourcePath === step.targetPath) continue;
			const inside = `${step.targetPath}${sep}`;
			for (const [laterIndex, later] of plan.entries()) {
				if (laterIndex <= index || !later.sourcePath.startsWith(inside)) continue;
				const salvaged = join(salvageRoot, String(laterIndex));
				copyPackage(later.sourcePath, salvaged);
				later.sourcePath = salvaged;
			}
			rmSync(step.targetPath, { recursive: true, force: true });
			copyPackage(step.sourcePath, step.targetPath);
		}
	} finally {
		rmSync(salvageRoot, { recursive: true, force: true });
	}

	pruneUnlistedPackages(codingAgentNodeModules, new Set(plan.map(({ lockPath }) => lockPath)), internalPackageNames);
	return manifest;
}
