// Every lockfile the repository ships must move with the version bump: the
// version:* scripts refresh bun.lock next to package-lock.json (b0ce15391), but
// releases go through this function, so bun.lock kept the previous release's
// workspace versions and a plain `bun install` on main rewrote it (2026.9.5-3
// through 2026.9.7 all shipped that way). One in-place `bun install --lockfile-only`
// pass bumped the workspace versions but kept the old workspace dependency ranges
// (senpi#2352), so the release uses the same isolated, fixed-point regeneration as
// `refresh-lock`.
export function runPackageLockRefresh(dryRun, runCommand, log, dryRunLog) {
	if (dryRun) {
		dryRunLog("npm install --package-lock-only --ignore-scripts");
		dryRunLog("npm install --ignore-scripts --no-audit --no-fund");
		dryRunLog("node scripts/regenerate-bun-lock-isolated.mjs");
		return;
	}
	log("npm install --package-lock-only --ignore-scripts");
	runCommand("npm", ["install", "--package-lock-only", "--ignore-scripts"]);
	log("npm install --ignore-scripts --no-audit --no-fund");
	runCommand("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"]);
	log("node scripts/regenerate-bun-lock-isolated.mjs");
	runCommand("node", ["scripts/regenerate-bun-lock-isolated.mjs"]);
}

// omo#8700: the released catalog may carry a Claude id the pinned Claude Code predates. Report it in the
// release log; the blocking check is the promoted-model regression test.
export function runClaudeCodeModelSupportReport(dryRun, runCommand, log, dryRunLog) {
	if (dryRun) {
		dryRunLog("node scripts/check-claude-code-model-support.mjs");
		return;
	}
	log("node scripts/check-claude-code-model-support.mjs");
	runCommand("node", ["scripts/check-claude-code-model-support.mjs"]);
}

export function runInstallLock(dryRun, runCommand, log, dryRunLog) {
	if (dryRun) {
		dryRunLog("node scripts/generate-coding-agent-install-lock.mjs");
		return;
	}
	log("node scripts/generate-coding-agent-install-lock.mjs");
	runCommand("node", ["scripts/generate-coding-agent-install-lock.mjs"]);
}
