#!/usr/bin/env node

/**
 * Syncs all workspace package dependency versions to match their current versions.
 * This ensures lockstep versioning across the monorepo.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findPackageDirectories } from "./package-workspaces.mjs";

const packages = findPackageDirectories()
	.map((directory) => {
		const path = join(directory, "package.json");
		return { data: JSON.parse(readFileSync(path, "utf8")), path };
	})
	.filter((pkg) => pkg.data.private !== true);

const versionMap = new Map(packages.map((pkg) => [pkg.data.name, pkg.data.version]));

console.log("Current versions:");
for (const [name, version] of [...versionMap].sort(([a], [b]) => a.localeCompare(b))) {
	console.log(`  ${name}: ${version}`);
}

// Verify all versions are the same (lockstep)
const versions = new Set(versionMap.values());
if (versions.size > 1) {
	console.error("\nERROR: Not all non-private packages have the same version.");
	console.error("Expected lockstep versioning. Run one of:");
	console.error("  npm run version:patch");
	console.error("  npm run version:minor");
	console.error("  npm run version:major");
	process.exit(1);
}

console.log("\nAll non-private packages are at the same version (lockstep).");

// Source manifests must stay on local lockstep workspace versions so local
// builds and tests resolve the current workspace packages. The release script
// rewrites publish-only dependency pins immediately before `npm publish` and
// restores these source versions afterward.

// Update all inter-package dependencies
let totalUpdates = 0;

function nextWorkspaceVersion(currentVersion, nextVersion) {
	return currentVersion.startsWith("^") ? `^${nextVersion}` : nextVersion;
}

for (const pkg of packages) {
	let updated = false;

	for (const dependencyType of ["dependencies", "devDependencies"]) {
		const dependencies = pkg.data[dependencyType];
		if (!dependencies) {
			continue;
		}

		for (const [depName, currentVersion] of Object.entries(dependencies)) {
			const dependencyVersion = versionMap.get(depName);
			if (!dependencyVersion) {
				continue;
			}

			const newVersion = nextWorkspaceVersion(currentVersion, dependencyVersion);
			if (currentVersion !== newVersion) {
				console.log(`\n${pkg.data.name}:`);
				console.log(`  ${depName}: ${currentVersion} → ${newVersion}${dependencyType === "devDependencies" ? " (devDependencies)" : ""}`);
				dependencies[depName] = newVersion;
				updated = true;
				totalUpdates++;
			}
		}
	}

	if (updated) {
		writeFileSync(pkg.path, `${JSON.stringify(pkg.data, null, "\t")}\n`);
	}
}

if (totalUpdates === 0) {
	console.log("\nAll inter-package dependencies are already in sync.");
} else {
	console.log(`\nUpdated ${totalUpdates} dependency version(s).`);
}
