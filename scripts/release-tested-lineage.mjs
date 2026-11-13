/**
 * What a release may tag after its suite ran in the forced-suite matrix jobs (senpi#6642). Those jobs tested one commit,
 * `tested`, and the release ships nothing else. It is either the dispatched commit itself (the catalog regeneration
 * changed nothing) or one commit on top of it, whose only parent is the dispatched commit and whose diff touches only the
 * paths the catalog generator writes. Anything else would ship code the dispatch did not ask for, or skip review.
 */

import { isRegeneratedCatalogPath } from "./release-test-gate.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/;


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
	const changed = capture("git", ["diff", "--name-status", "--no-renames", base, tested])
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [status, path] = line.split("\t");
			return { path, side: status === "D" ? base : tested };
		});
	if (changed.length === 0) throw new Error(`the tested commit ${short} changes nothing; it should have been ${base.slice(0, 12)} itself`);
	// A shard's ownership is read from its own text: the version committed, or the removed one for a deletion.
	const content = ({ path, side }) => (path.endsWith(".models.ts") ? capture("git", ["show", `${side}:${path}`]) : undefined);
	const outside = changed.filter((entry) => !isRegeneratedCatalogPath(entry.path, content(entry))).map((entry) => entry.path);
	if (outside.length > 0) {
		throw new Error(
			`the tested commit ${short} changes ${outside.join(", ")}, outside the regenerated catalog (models.generated.ts, providers/*.models.ts, providers/data/)`,
		);
	}
	return "catalog";
}

/**
 * What a release may stamp, tag and push at all (senpi#6645): HEAD reachable from the freshly fetched origin/main, or
 * the single catalog-only child of a commit that is (the release-only catalog commit). The local branch name proves
 * nothing, since `git checkout -B main` names any commit main.
 * @param {{runCommand: (bin: string, args: string[]) => void, capture: (bin: string, args: string[]) => string, log: (line: string) => void}} deps
 * @returns {"on-main"|"catalog-child"}
 */
export function assertHeadOnOriginMain({ runCommand, capture, log }) {
	log("git fetch origin main");
	runCommand("git", ["fetch", "origin", "main"]);
	const head = capture("git", ["rev-parse", "HEAD"]).trim();
	const onMain = (sha) => {
		try {
			runCommand("git", ["merge-base", "--is-ancestor", sha, "origin/main"]);
			return true;
		} catch {
			return false;
		}
	};
	if (onMain(head)) return "on-main";
	const refusal = `HEAD ${head.slice(0, 12)} is not reachable from origin/main, nor the single catalog-only child of a commit that is; a release ships only main's commits, whatever the local branch is called`;
	const parents = capture("git", ["rev-list", "--parents", "-n", "1", head]).trim().split(/\s+/).slice(1);
	if (parents.length !== 1 || !onMain(parents[0])) throw new Error(refusal);
	try {
		assertTestedLineage({ base: parents[0], tested: head, capture });
	} catch (error) {
		throw new Error(`${refusal} (${error instanceof Error ? error.message : String(error)})`, { cause: error });
	}
	return "catalog-child";
}
