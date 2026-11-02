import { changelogAfterPinnedRelease } from "./release-pinned-changelog.mjs";

/**
 * Release an exact commit instead of whatever main is at dispatch (senpi#3609). The commit must be one of main's own
 * first-parent commits, so a release never ships a tree main did not have. The checks are read-only, so a dry run
 * performs them too and previews a bad sha as an error; only the checkout is previewed.
 */
export function pinReleaseCommit(sha, dryRun, runCommand, log, dryRunLog, capture) {
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
	if (dryRun) {
		dryRunLog(`git checkout -B main ${sha}`);
		return;
	}
	log(`releasing the pinned commit ${sha.slice(0, 12)} (main may have moved past it)`);
	runCommand("git", ["checkout", "-B", "main", sha]);
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
 * Merge the newer main into a pinned release without moving main's later changelog entries under the released version
 * (senpi#3731 review). A plain merge puts every entry main added after the pinned commit into the stamped section, so
 * main would claim the release shipped them. Each changelog is rebuilt from main's [Unreleased] minus the pinned
 * entries, the tag's own release section, and main's older sections. The tag itself is never touched.
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
	const unresolved = capture("git", ["diff", "--name-only", "--diff-filter=U"]).trim();
	if (unresolved) {
		throw new Error(`merging main into the pinned release left conflicts outside the changelogs: ${unresolved.split("\n").join(", ")}`);
	}
	runCommand("git", ["commit", "--no-edit"]);
}
