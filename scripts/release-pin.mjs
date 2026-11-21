import { changelogAfterPinnedRelease } from "./release-pinned-changelog.mjs";
import { GENERATED_HEADER, isRegeneratedCatalogPath } from "./release-test-gate.mjs";

/**
 * Release an exact commit instead of whatever main is at dispatch (senpi#3609). The commit must be one of main's own
 * first-parent commits, so a release never ships a tree main did not have. The checks are read-only, so a dry run
 * performs them too and previews a bad sha as an error; only the checkout is previewed.
 */
export function pinReleaseCommit(sha, dryRun, runCommand, log, dryRunLog, capture) {
	assertReleasableCommit(sha, runCommand, log, capture);
	if (dryRun) {
		dryRunLog(`git checkout -B main ${sha}`);
		return;
	}
	log(`releasing the pinned commit ${sha.slice(0, 12)} (main may have moved past it)`);
	runCommand("git", ["checkout", "-B", "main", sha]);
}

/** The read-only half of `pinReleaseCommit`: `sha` is a full sha on main's own first-parent history. */
export function assertReleasableCommit(sha, runCommand, log, capture) {
	if (!/^[0-9a-f]{40}$/.test(sha)) {
		throw new Error(`--sha needs a full 40-character commit sha, got ${JSON.stringify(sha)}`);
	}
	log("git fetch origin main");
	runCommand("git", ["fetch", "origin", "main"]);
	try {
		runCommand("git", ["merge-base", "--is-ancestor", sha, "origin/main"]);
	} catch (error) {
		throw new Error(`${sha.slice(0, 12)} is not on main; a release ships only commits main already contains`, { cause: error });
	}
	// A merged PR's head is an ancestor of main too, but its tree never was main's state: it lacks main's commits
	// between the PR's base and its merge.
	if (!capture("git", ["rev-list", "--first-parent", "origin/main"]).split("\n").includes(sha)) {
		throw new Error(
			`${sha.slice(0, 12)} is not one of main's own commits (it reached main through a merged branch); pin a commit on main's first-parent history`,
		);
	}
}

/**
 * Pin the release, then reinstall and rebuild when the pinned tree differs from the job's checkout: the job installed
 * and built main's tip, and the forced suite and catalog regeneration must run the pinned code on its own dependencies.
 */
export function preparePinnedRelease({ sha, dryRun, runCommand, capture, build, driftPaths, log, dryRunLog }) {
	const before = capture("git", ["rev-parse", "HEAD"]).trim();
	pinReleaseCommit(sha, dryRun, runCommand, log, dryRunLog, capture);
	if (dryRun || before === sha) return;
	log("the pinned commit differs from the checkout: reinstalling and rebuilding it");
	runCommand("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"]);
	build();
	runCommand("git", ["checkout", "--", ...driftPaths]);
}

/**
 * Put main's whole generated catalog back after the merge (senpi#6119). The catalog is one unit: `.manifest.json`
 * records a hash for every data file, so taking main's side only where git conflicted would pair main's manifest with
 * a data file only the release changed. Every generated file main has goes back to main's content, and every
 * generated file only the release added goes away.
 */
function restoreMainCatalog(capture, runCommand, show, log) {
	const listed = (args) => capture("git", args).split("\n").filter(Boolean);
	const candidates = new Set([...listed(["ls-files"]), ...listed(["ls-tree", "-r", "--name-only", "origin/main"])]);
	const fromMain = [];
	const releaseOnly = [];
	for (const file of candidates) {
		// Path-only pass first (a header-carrying shard is the only content-dependent case), so only catalog paths are read.
		if (!isRegeneratedCatalogPath(file, GENERATED_HEADER)) continue;
		const main = show("origin/main", file);
		if (!isRegeneratedCatalogPath(file, main ?? show("HEAD", file) ?? "")) continue;
		(main === null ? releaseOnly : fromMain).push(file);
	}
	if (fromMain.length + releaseOnly.length === 0) return;
	log(`  generated catalog: keeping main's ${fromMain.length} file(s); the tag keeps the release's`);
	if (fromMain.length > 0) runCommand("git", ["checkout", "origin/main", "--", ...fromMain]);
	if (releaseOnly.length > 0) runCommand("git", ["rm", "-q", "-f", "--", ...releaseOnly]);
}

/**
 * Merge the newer main into a pinned release without moving main's later changelog entries under the released version
 * (senpi#3731 review). A plain merge puts every entry main added after the pinned commit into the stamped section, so
 * main would claim the release shipped them. Each changelog is rebuilt from main's [Unreleased] minus the pinned
 * entries, the tag's own release section, and main's older sections. A conflict in a generated model-catalog file
 * keeps main's side (senpi#6119): the release's regenerated catalog is a release-only commit the tag already carries,
 * and main's own catalog refreshes stay main's. The tag itself is never touched.
 */
export function syncPinnedReleaseIntoMain({ pinnedSha, version, changelogs, dryRun, runCommand, capture, readFile, writeFile, log, dryRunLog }) {
	if (dryRun) {
		dryRunLog("git fetch origin main");
		dryRunLog("git merge --no-edit --no-commit origin/main; CHANGELOG entries merged after the pinned commit stay under [Unreleased]");
		return;
	}
	log("git fetch origin main");
	runCommand("git", ["fetch", "origin", "main"]);
	try {
		runCommand("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"]);
		log("remote main is already an ancestor of the release branch");
		return;
	} catch {
		log("git merge --no-edit --no-commit origin/main");
	}
	try {
		runCommand("git", ["merge", "--no-edit", "--no-commit", "origin/main"]);
	} catch {
		log("the merge stopped on conflicts; the changelogs are rebuilt below and any other conflict fails the release");
	}
	const show = (ref, file) => {
		try {
			return capture("git", ["show", `${ref}:${file}`]);
		} catch {
			return null;
		}
	};
	for (const file of changelogs) {
		const main = show("origin/main", file);
		const released = show(`v${version}`, file);
		if (main === null || released === null) continue;
		const next = changelogAfterPinnedRelease({ main, pinned: show(pinnedSha, file) ?? "", released, version });
		if (next === null) continue;
		if (readFile(file) !== next) log(`  ${file}: entries merged after ${pinnedSha.slice(0, 12)} stay under [Unreleased]`);
		writeFile(file, next);
		runCommand("git", ["add", "--", file]);
	}
	restoreMainCatalog(capture, runCommand, show, log);
	const unresolved = capture("git", ["diff", "--name-only", "--diff-filter=U"]).trim();
	if (unresolved) {
		throw new Error(`merging main into the pinned release left conflicts outside the changelogs: ${unresolved.split("\n").join(", ")}`);
	}
	runCommand("git", ["commit", "--no-edit"]);
}
