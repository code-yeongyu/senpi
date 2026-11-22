/**
 * What counts as model-catalog drift after `packages/ai/scripts/generate-models.ts` ran in a checkout. The daily refresh
 * workflows are the only place the catalog is regenerated (senpi#2287): a release ships the catalog main committed.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

/**
 * Git pathspecs for exactly what `packages/ai/scripts/generate-models.ts` writes: the aggregator, the per-provider
 * `*.models.ts` shards (written, added and pruned there), and the `providers/data/` JSON plus its manifest. The rest of
 * `packages/ai/src/providers/` is hand-written provider runtime code and never counts as catalog (senpi#6645 review).
 */
export const REGENERATED_CATALOG_PATHS = [
	"packages/ai/src/models.generated.ts",
	"packages/ai/src/providers/data",
	":(glob)packages/ai/src/providers/*.models.ts",
];

/**
 * The catalog files the regeneration changed, added or removed.
 * @param {string} cwd repository root
 */
export function changedCatalogPaths(cwd) {
	// -z: paths come unquoted and NUL-terminated. A rename or copy entry is followed by its source path, which is skipped.
	const records = execFileSync("git", ["status", "--porcelain", "-z", "--untracked-files=all", "--", ...REGENERATED_CATALOG_PATHS], {
		cwd,
		encoding: "utf8",
	}).split("\0");
	const paths = [];
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (record.length < 4) continue;
		paths.push(record.slice(3));
		if (/[RC]/.test(record.slice(0, 2))) index++;
	}
	return paths;
}

export const CATALOG_MANIFEST = "packages/ai/src/providers/data/.manifest.json";

/**
 * True when two catalog manifests differ only in `generatedAt`, the timestamp every regeneration stamps.
 * @param {string} before manifest text at HEAD
 * @param {string} after regenerated manifest text
 */
export function isTimestampOnlyManifestChange(before, after) {
	const { generatedAt: _before, ...beforeRest } = JSON.parse(before);
	const { generatedAt: _after, ...afterRest } = JSON.parse(after);
	return isDeepStrictEqual(beforeRest, afterRest);
}

/**
 * Restore the catalog manifest when the regeneration changed nothing but its `generatedAt` stamp, so an unchanged
 * catalog reads as unchanged. Without this every regeneration looked like drift.
 * @param {string} cwd repository root
 * @returns {boolean} whether the stamp-only change was discarded
 */
export function discardTimestampOnlyCatalogChange(cwd) {
	const changed = changedCatalogPaths(cwd);
	if (changed.length !== 1 || changed[0] !== CATALOG_MANIFEST) return false;
	const before = execFileSync("git", ["show", `HEAD:${CATALOG_MANIFEST}`], { cwd, encoding: "utf8" });
	const after = readFileSync(join(cwd, CATALOG_MANIFEST), "utf8");
	if (!isTimestampOnlyManifestChange(before, after)) return false;
	execFileSync("git", ["checkout", "--", CATALOG_MANIFEST], { cwd });
	return true;
}
