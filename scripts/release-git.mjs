export function syncRemoteMainBeforePush(dryRun, runCommand, log, dryRunLog) {
	if (dryRun) {
		dryRunLog("git fetch origin main");
		dryRunLog("git merge --no-edit origin/main (if remote main advanced)");
		return;
	}

	log("git fetch origin main");
	runCommand("git", ["fetch", "origin", "main"]);

	try {
		runCommand("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"]);
		log("remote main is already an ancestor of the release branch");
	} catch {
		log("git merge --no-edit origin/main");
		runCommand("git", ["merge", "--no-edit", "origin/main"]);
	}
}
