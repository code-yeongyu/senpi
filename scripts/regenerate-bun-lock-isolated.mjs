#!/usr/bin/env node
// Regenerate bun.lock without letting Bun touch the npm-owned tree.
//
// The repository is installed and locked by npm (package-lock.json, the generated
// coding-agent install-lock and publish-deps manifests). Running `bun install
// --lockfile-only` in place makes Bun read the npm lockfiles and the hoisted
// node_modules, and it happily rewrites workspace manifests (version specs, trusted
// dependency bookkeeping) while doing so. That is the mixed-tool hazard: a Bun run
// silently mutates files that only npm is allowed to own.
//
// Instead, copy every workspace manifest at its identical relative path into a
// namespaced temp island that contains NO package-lock.json, NO npm-shrinkwrap.json
// and NO node_modules, resolve there, and copy back exactly one file: bun.lock.
// Manifest digests are compared before and after, in the repository and in the island,
// so a mutating Bun run fails loudly instead of landing an unreviewed manifest edit.
//
// Usage: node scripts/regenerate-bun-lock-isolated.mjs [--check]
//   --check  resolve in the island and fail if the repository bun.lock would change

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ISLAND_PREFIX = "senpi-bun-lock-island-";
export const FORBIDDEN_ISLAND_ENTRIES = ["package-lock.json", "npm-shrinkwrap.json", "node_modules"];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRootDefault = resolve(scriptDir, "..");

/** Expand one workspace pattern. Only a trailing `*` segment is supported, which is all the root manifest uses. */
function expandWorkspacePattern(repoRoot, pattern) {
	if (!pattern.includes("*")) {
		return existsSync(join(repoRoot, pattern, "package.json")) ? [pattern] : [];
	}
	const starIndex = pattern.indexOf("*");
	if (pattern.slice(starIndex) !== "*") {
		throw new Error(`Unsupported workspace pattern ${pattern}; only a trailing "*" segment is supported`);
	}
	const parent = pattern.slice(0, starIndex).replace(/\/$/, "");
	const parentDir = join(repoRoot, parent);
	if (!existsSync(parentDir)) return [];
	return readdirSync(parentDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
		.map((entry) => `${parent}/${entry.name}`)
		.filter((relativePath) => existsSync(join(repoRoot, relativePath, "package.json")))
		.sort((a, b) => a.localeCompare(b));
}

/** Every manifest Bun must see: the root manifest plus one per workspace, at identical relative paths. */
export function collectWorkspaceManifestPaths(repoRoot = repoRootDefault) {
	const rootManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
	const patterns = rootManifest.workspaces ?? [];
	const manifestPaths = ["package.json"];
	const seen = new Set(manifestPaths);
	for (const pattern of patterns) {
		for (const workspace of expandWorkspacePattern(repoRoot, pattern)) {
			const manifestPath = `${workspace}/package.json`;
			if (seen.has(manifestPath)) continue;
			seen.add(manifestPath);
			manifestPaths.push(manifestPath);
		}
	}
	return manifestPaths;
}

export function hashFile(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function hashManifests(root, manifestPaths) {
	return new Map(manifestPaths.map((manifestPath) => [manifestPath, hashFile(join(root, manifestPath))]));
}

export function diffManifestHashes(before, after) {
	const changed = [];
	for (const [manifestPath, digest] of before) {
		if (after.get(manifestPath) !== digest) changed.push(manifestPath);
	}
	for (const manifestPath of after.keys()) {
		if (!before.has(manifestPath)) changed.push(manifestPath);
	}
	return changed.sort((a, b) => a.localeCompare(b));
}

/** The island must never expose an npm lockfile or an installed tree to Bun. */
export function assertIslandIsClean(islandRoot) {
	const offenders = [];
	const pending = [islandRoot];
	while (pending.length > 0) {
		const current = pending.pop();
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (FORBIDDEN_ISLAND_ENTRIES.includes(entry.name)) {
				offenders.push(path.slice(islandRoot.length + 1));
				continue;
			}
			if (entry.isDirectory()) pending.push(path);
		}
	}
	if (offenders.length > 0) {
		throw new Error(
			`Bun lock island is contaminated by npm-owned artifacts: ${offenders.sort((a, b) => a.localeCompare(b)).join(", ")}`,
		);
	}
	return true;
}

export function assertSupportedBunVersion(version) {
	if (!/^1\.4\./.test(String(version).trim())) {
		throw new Error(`bun 1.4.x is required to regenerate bun.lock, found ${String(version).trim() || "<unknown>"}`);
	}
	return true;
}

export function createIsland(repoRoot, manifestPaths, islandRoot, { seedLockfile = true } = {}) {
	mkdirSync(islandRoot, { recursive: true });
	for (const manifestPath of manifestPaths) {
		const target = join(islandRoot, manifestPath);
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(join(repoRoot, manifestPath), target);
	}
	// bun.lock is Bun-owned, so seeding it keeps the regeneration incremental (stable
	// resolutions, reviewable diff). npm-owned lockfiles are deliberately never copied.
	const lockfile = join(repoRoot, "bun.lock");
	if (seedLockfile && existsSync(lockfile)) copyFileSync(lockfile, join(islandRoot, "bun.lock"));
	assertIslandIsClean(islandRoot);
	return islandRoot;
}

function defaultRunBun(islandRoot) {
	const version = spawnSync("bun", ["--version"], { encoding: "utf8" });
	if (version.status !== 0) {
		throw new Error(`bun is required to regenerate bun.lock: ${version.stderr ?? version.error?.message ?? ""}`);
	}
	assertSupportedBunVersion(version.stdout);
	const install = spawnSync("bun", ["install", "--ignore-scripts", "--lockfile-only"], {
		cwd: islandRoot,
		encoding: "utf8",
		stdio: "inherit",
	});
	if (install.status !== 0) {
		throw new Error(`bun install --ignore-scripts --lockfile-only failed in the island (exit ${install.status})`);
	}
	return version.stdout.trim();
}

/**
 * Resolve bun.lock inside a disposable island and copy back only bun.lock.
 * Returns { lockfile, changed, bunVersion, islandRoot } where `lockfile` is the regenerated content.
 */
export function regenerateBunLock({
	repoRoot = repoRootDefault,
	runBun = defaultRunBun,
	islandParent = tmpdir(),
	check = false,
	keepIsland = false,
} = {}) {
	const manifestPaths = collectWorkspaceManifestPaths(repoRoot);
	const repositoryHashesBefore = hashManifests(repoRoot, manifestPaths);
	const islandRoot = mkdtempSync(join(islandParent, ISLAND_PREFIX));
	try {
		createIsland(repoRoot, manifestPaths, islandRoot);
		const islandHashesBefore = hashManifests(islandRoot, manifestPaths);
		const bunVersion = runBun(islandRoot);
		assertIslandIsClean(islandRoot);

		const islandMutated = diffManifestHashes(islandHashesBefore, hashManifests(islandRoot, manifestPaths));
		if (islandMutated.length > 0) {
			throw new Error(`bun rewrote workspace manifests in the island: ${islandMutated.join(", ")}`);
		}
		const repositoryMutated = diffManifestHashes(repositoryHashesBefore, hashManifests(repoRoot, manifestPaths));
		if (repositoryMutated.length > 0) {
			throw new Error(`bun mutated npm-owned manifests in the repository: ${repositoryMutated.join(", ")}`);
		}

		const islandLockfile = join(islandRoot, "bun.lock");
		if (!existsSync(islandLockfile) || !statSync(islandLockfile).isFile()) {
			throw new Error("bun install --lockfile-only produced no bun.lock in the island");
		}
		const lockfile = readFileSync(islandLockfile, "utf8");
		const repositoryLockfile = join(repoRoot, "bun.lock");
		const previous = existsSync(repositoryLockfile) ? readFileSync(repositoryLockfile, "utf8") : undefined;
		const changed = previous !== lockfile;
		if (!check && changed) writeFileSync(repositoryLockfile, lockfile);
		return { lockfile, changed, bunVersion, islandRoot };
	} finally {
		if (!keepIsland) rmSync(islandRoot, { recursive: true, force: true });
	}
}

function main(argv) {
	const args = new Set(argv);
	for (const arg of args) {
		if (arg !== "--check") {
			console.error(`Unknown argument: ${arg}`);
			return 2;
		}
	}
	const check = args.has("--check");
	const { changed, bunVersion } = regenerateBunLock({ check });
	if (check && changed) {
		console.error("bun.lock is out of date. Run: npm run refresh-lock");
		return 1;
	}
	console.log(
		check
			? `bun.lock is up to date (bun ${bunVersion}).`
			: `Regenerated bun.lock in an isolated island (bun ${bunVersion}, ${changed ? "updated" : "unchanged"}).`,
	);
	return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	try {
		process.exit(main(process.argv.slice(2)));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
