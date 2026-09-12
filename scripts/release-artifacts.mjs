// Every lockfile the repository ships must move with the version bump: the
// version:* scripts refresh bun.lock next to package-lock.json (b0ce15391), but
// releases go through this function, so bun.lock kept the previous release's
// workspace versions and a plain `bun install` on main rewrote it (2026.9.5-3
// through 2026.9.7 all shipped that way).
export function runPackageLockRefresh(dryRun, runCommand, log, dryRunLog) {
	if (dryRun) {
		dryRunLog("npm install --package-lock-only --ignore-scripts");
		dryRunLog("npm install --ignore-scripts --no-audit --no-fund");
		dryRunLog("bun install --lockfile-only");
		return;
	}
	log("npm install --package-lock-only --ignore-scripts");
	runCommand("npm", ["install", "--package-lock-only", "--ignore-scripts"]);
	log("npm install --ignore-scripts --no-audit --no-fund");
	runCommand("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"]);
	log("bun install --lockfile-only");
	runCommand("bun", ["install", "--lockfile-only"]);
}

export function runGenerateModels(dryRun, runCommand, log, dryRunLog) {
	if (dryRun) {
		dryRunLog("npm --prefix packages/ai run generate-models");
		return;
	}
	log("npm --prefix packages/ai run generate-models");
	runCommand("npm", ["--prefix", "packages/ai", "run", "generate-models"]);
}

export function runGenerateImageModels(dryRun, runCommand, log, dryRunLog) {
	if (dryRun) {
		dryRunLog("npm --prefix packages/ai run generate-image-models");
		return;
	}
	log("npm --prefix packages/ai run generate-image-models");
	runCommand("npm", ["--prefix", "packages/ai", "run", "generate-image-models"]);
}

export function runShrinkwrap(dryRun, runCommand, log, dryRunLog) {
	if (dryRun) {
		dryRunLog("node scripts/generate-coding-agent-shrinkwrap.mjs");
		return;
	}
	log("node scripts/generate-coding-agent-shrinkwrap.mjs");
	runCommand("node", ["scripts/generate-coding-agent-shrinkwrap.mjs"]);
}

export function runInstallLock(dryRun, runCommand, log, dryRunLog) {
	if (dryRun) {
		dryRunLog("node scripts/generate-coding-agent-install-lock.mjs");
		return;
	}
	log("node scripts/generate-coding-agent-install-lock.mjs");
	runCommand("node", ["scripts/generate-coding-agent-install-lock.mjs"]);
}
