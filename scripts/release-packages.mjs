import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findPackageDirectories } from "./package-workspaces.mjs";
import { registrySourcePackageNames, resolveRegistryPackages } from "./registry-packages.mjs";

export const WORKSPACE_PACKAGES = [
	"packages/ai/package.json",
	"packages/agent/package.json",
	"packages/client/package.json",
	"packages/coding-agent/package.json",
	"packages/protocol/package.json",
	"packages/server/package.json",
	"packages/pty/package.json",
	"packages/telemetry/package.json",
	"packages/senpi-codemode/package.json",
	"packages/tui/package.json",
];

// Runtime workspaces that senpi depends on but that do NOT ride the fork's CalVer lockstep: they
// keep upstream's own release version. The install-lock generator must still treat them as internal
// (resolving their dependency closure from the local workspace manifest, never fetching upstream
// registry metadata) so the closure matches the in-tree copy; they are exempt
// from the lockstep version check because their version is not the fork CalVer. chord is here
// because it is byte-for-byte upstream apart from packaging metadata, so it keeps `@earendil-works/chord`'s
// own published identity instead of a fork alias (issue #1632).
export const BUNDLED_INTERNAL_WORKSPACES = ["packages/chord/package.json"];

function writeWorkspaceVersion(file, version, dryRun, log, dryRunLog) {
	const raw = readFileSync(file, "utf-8");
	const pkg = JSON.parse(raw);
	const previous = pkg.version;
	if (previous === version) {
		log(`  ${file}: already ${version}`);
		return;
	}
	if (dryRun) {
		dryRunLog(`write ${file} (version: ${previous} -> ${version})`);
		return;
	}
	pkg.version = version;
	writeFileSync(file, `${JSON.stringify(pkg, null, "\t")}\n`);
	log(`  ${file}: ${previous} -> ${version}`);
}

export function applyWorkspaceVersions(version, dryRun, log, dryRunLog) {
	log(`applying version ${version} to ${WORKSPACE_PACKAGES.length} workspace package.json files`);
	for (const file of WORKSPACE_PACKAGES) {
		writeWorkspaceVersion(file, version, dryRun, log, dryRunLog);
	}
}

export function runSyncVersions(dryRun, runCommand, log, dryRunLog) {
	if (dryRun) {
		dryRunLog("node scripts/sync-versions.js");
		return;
	}
	log("running scripts/sync-versions.js");
	runCommand("node", ["scripts/sync-versions.js"]);
}

export function getPublicWorkspacePackages() {
	const workspacePackages = findPackageDirectories()
		.map((directory) => ({
			directory,
			...JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
		}));
	return resolveRegistryPackages(workspacePackages).map(({ directory, registryName, version }) => ({
			directory,
			name: registryName,
			version,
		}));
}

// Upstream's check-runtime-deps targets every workspace package without `private: true`.
// The fork's published sources are `private: true` under their upstream `@earendil-works/pi-*`
// names (publish.mjs rewrites them to `@code-yeongyu/senpi-*` manifests), so the fork's
// runtime-dependency contract is the union: public-by-flag packages (client/protocol here,
// everything in upstream-shaped fixtures) plus the fork's registry sources. Private,
// unpublished workspaces (chord, senpi-server, sqlite-node) stay out; chord keeps upstream's own
// release identity so its declared edges resolve to upstream's published version (issue #1632).
export function getRuntimeDepsCheckPackages() {
	return findPackageDirectories()
		.map((directory) => ({
			directory,
			...JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
		}))
		.filter((pkg) => pkg.private !== true || registrySourcePackageNames.has(pkg.name))
		.map(({ directory }) => ({ directory }));
}
