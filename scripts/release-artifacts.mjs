export function runPackageLockRefresh(dryRun, runCommand, log, dryRunLog) {
	if (dryRun) {
		dryRunLog("npm install --package-lock-only --ignore-scripts");
		return;
	}
	log("npm install --package-lock-only --ignore-scripts");
	runCommand("npm", ["install", "--package-lock-only", "--ignore-scripts"]);
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
