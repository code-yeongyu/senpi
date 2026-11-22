#!/usr/bin/env node
/**
 * Refuse a release version that the shipped update checker cannot order (senpi#5406).
 *
 * `2026.11.02-1` was cut while `packages/coding-agent/src/utils/version-check.ts` could not parse it, so every
 * install of that release compared the registry's latest version as `undefined` and never offered an update. This
 * guard asks the checker in the tree being released, never a copy of its pattern: run it as a subprocess after a
 * pinned `--sha` checkout and it loads that tree's checker.
 *
 *   node scripts/release-version-guard.mjs <version>   -> exit 1 unless the shipped checker orders <version>
 */

import { pathToFileURL } from "node:url";
import { comparePackageVersions } from "../packages/coding-agent/src/utils/version-check.ts";

/**
 * Return the reason `compare` cannot order `version` as a release, or `undefined` when it can.
 *
 * A release must compare equal to itself (the checker parses it) and never before the bare release of its own date,
 * so a revision such as `-0` or `-rc1` that the checker reads as a semver prerelease is refused.
 *
 * @param {string} version
 * @param {(left: string, right: string) => number | undefined} compare
 * @returns {string | undefined}
 */
export function shippedCheckerRefusal(version, compare = comparePackageVersions) {
	if (compare(version, version) !== 0) {
		return `the shipped update checker cannot parse ${JSON.stringify(version)}`;
	}
	const bareRelease = version.split("-")[0];
	const againstBare = compare(version, bareRelease);
	if (againstBare === undefined || againstBare < 0) {
		return `the shipped update checker orders ${JSON.stringify(version)} before ${JSON.stringify(bareRelease)}`;
	}
	return undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const version = process.argv[2] ?? "";
	const refusal = shippedCheckerRefusal(version);
	if (refusal) {
		process.stderr.write(
			`[release-version-guard] error: ${refusal}; installs of this release would never be offered an update (packages/coding-agent/src/utils/version-check.ts)\n`,
		);
		process.exit(1);
	}
	process.stdout.write(`${version}\n`);
}
