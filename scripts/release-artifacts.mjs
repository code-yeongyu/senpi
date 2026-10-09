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

export function runGenerateModels(dryRun, runCommand, log, dryRunLog) {
	if (dryRun) {
		dryRunLog("npm --prefix packages/ai run generate-models");
		return;
	}
	log("npm --prefix packages/ai run generate-models");
	runCommand("npm", ["--prefix", "packages/ai", "run", "generate-models"]);
}

// senpi#2645: a regeneration can drop the model a bundled provider names as its default (#2175, #2295, #926).
// The release test gate may skip on HEAD's green CI, which ran before the regen, so check the defaults here,
// right after it: the release stops instead of shipping a default its own catalog no longer has.
export function runProviderDefaultsCheck(dryRun, runCommand, log, dryRunLog) {
	if (dryRun) {
		dryRunLog("npm --prefix packages/coding-agent run check:provider-defaults");
		return;
	}
	log("npm --prefix packages/coding-agent run check:provider-defaults");
	runCommand("npm", ["--prefix", "packages/coding-agent", "run", "check:provider-defaults"], { CI: "1" });
}

// omo#8700: the catalog just regenerated from the network may carry a Claude id the pinned Claude Code
// predates. Report it in the release log; the blocking check is the promoted-model regression test.
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
