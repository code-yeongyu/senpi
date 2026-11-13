/**
 * What a release may tag after its suite ran in the forced-suite matrix jobs (senpi#6642). Those jobs tested one commit,
 * `tested`, and the release ships nothing else. It is either the dispatched commit itself (the catalog regeneration
 * changed nothing) or one commit on top of it, whose only parent is the dispatched commit and whose diff touches only the
 * paths the catalog generator writes. Anything else would ship code the dispatch did not ask for, or skip review.
 */

import { REGENERATED_CATALOG_PATHS } from "./release-test-gate.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/;

const isCatalogPath = (path) => REGENERATED_CATALOG_PATHS.some((owned) => path === owned || path.startsWith(`${owned}/`));

/**
 * @param {{base: string, tested: string, capture: (bin: string, args: string[]) => string}} input
 *   base is the dispatched commit (`--sha`), tested the commit the matrix jobs tested.
 * @returns {"unchanged"|"catalog"}
 */
export function assertTestedLineage({ base, tested, capture }) {
	for (const [name, sha] of [["--sha", base], ["--tested-sha", tested]]) {
		if (!FULL_SHA.test(sha)) throw new Error(`${name} needs a full 40-character commit sha, got ${JSON.stringify(sha)}`);
	}
	if (tested === base) return "unchanged";
	const short = tested.slice(0, 12);
	const parents = capture("git", ["rev-list", "--parents", "-n", "1", tested]).trim().split(/\s+/).slice(1);
	if (parents.length !== 1) {
		throw new Error(`the tested commit ${short} has ${parents.length} parents; it must be one commit whose only parent is ${base.slice(0, 12)}`);
	}
	if (parents[0] !== base) {
		throw new Error(`the tested commit ${short} has parent ${parents[0].slice(0, 12)}, not the dispatched ${base.slice(0, 12)}`);
	}
	const changed = capture("git", ["diff", "--name-only", "--no-renames", base, tested]).split("\n").filter(Boolean);
	if (changed.length === 0) throw new Error(`the tested commit ${short} changes nothing; it should have been ${base.slice(0, 12)} itself`);
	const outside = changed.filter((path) => !isCatalogPath(path));
	if (outside.length > 0) {
		throw new Error(
			`the tested commit ${short} changes ${outside.join(", ")}, outside the regenerated catalog (${REGENERATED_CATALOG_PATHS.join(", ")})`,
		);
	}
	return "catalog";
}
