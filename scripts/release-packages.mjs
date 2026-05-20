import { readFileSync, writeFileSync } from "node:fs";

export const WORKSPACE_PACKAGES = [
	"packages/ai/package.json",
	"packages/agent/package.json",
	"packages/coding-agent/package.json",
	"packages/tui/package.json",
	"packages/web-ui/package.json",
];

function writeWorkspaceVersion(file, version, dryRun, log, dryRunLog) {
	const raw = readFileSync(file, "utf-8");
	const pkg = JSON.parse(raw);
	const previous = pkg.version;
	if (previous === version) {
		log(`  ${file}: already ${version}`);
		return;
	}
	if (dryRun) {
		dryRunLog(`write ${file} (version: ${previous} -> ${version})`);
		return;
	}
	pkg.version = version;
	writeFileSync(file, `${JSON.stringify(pkg, null, "\t")}\n`);
	log(`  ${file}: ${previous} -> ${version}`);
}

export function applyWorkspaceVersions(version, dryRun, log, dryRunLog) {
	log(`applying version ${version} to ${WORKSPACE_PACKAGES.length} workspace package.json files`);
	for (const file of WORKSPACE_PACKAGES) {
		writeWorkspaceVersion(file, version, dryRun, log, dryRunLog);
	}
}

export function runSyncVersions(dryRun, runCommand, log, dryRunLog) {
	if (dryRun) {
		dryRunLog("node scripts/sync-versions.js");
		return;
	}
	log("running scripts/sync-versions.js");
	runCommand("node", ["scripts/sync-versions.js"]);
}
