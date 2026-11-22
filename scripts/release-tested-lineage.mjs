/**
 * What a release may stamp, tag and push at all (senpi#6645): HEAD reachable from the freshly fetched origin/main.
 * The local branch name proves nothing, since `git checkout -B main` names any commit main. The release never adds a
 * commit of its own before stamping (it ships the catalog main committed, senpi#2287), so nothing else qualifies.
 * @param {{runCommand: (bin: string, args: string[]) => void, capture: (bin: string, args: string[]) => string, log: (line: string) => void}} deps
 */
export function assertHeadOnOriginMain({ runCommand, capture, log }) {
	log("git fetch origin main");
	runCommand("git", ["fetch", "origin", "main"]);
	const head = capture("git", ["rev-parse", "HEAD"]).trim();
	// Plain ancestry, not first-parent: a merged PR's head is reachable from origin/main too and passes here. That is
	// acceptable for this second layer, which refuses commits main never received; the first-parent guarantee (main's own
	// commits only) is the --sha path's `assertReleasableCommit` in release-pin.mjs, run first for every pinned or
	// --shard-results release, while a default release releases the checked-out main tip itself.
	try {
		runCommand("git", ["merge-base", "--is-ancestor", head, "origin/main"]);
	} catch (error) {
		throw new Error(
			`HEAD ${head.slice(0, 12)} is not reachable from origin/main; a release ships only main's commits, whatever the local branch is called`,
			{ cause: error },
		);
	}
}
