#!/usr/bin/env node
/**
 * The `prepare` job of a release dispatched with `force_tests` (senpi#6642, `.github/workflows/publish-npm.yml`).
 *
 *   node scripts/release-forced-prepare.mjs --github-output <file> [--sha <sha>] [--version <v>]
 *
 * It fixes what every later job of the run uses: `base_sha`, the commit the matrix jobs test and the release tags (the
 * `--sha` input after checking it is one of main's own commits, else the checked-out commit; resolved once, here, and
 * printed in full), and the release `version` (fixed now, so a suite that crosses 00:00 UTC cannot change it). The
 * release ships the model catalog that commit carries (senpi#2287), so nothing is regenerated, installed or built here.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { computeNextVersion } from "./calver.mjs";
import { assertReleasableCommit } from "./release-pin.mjs";

const VERSION_RE = /^\d{4}\.\d{1,2}\.\d{1,2}(-\d+)?$/;

/** `$GITHUB_OUTPUT` lines for the prepare job's outputs. */
export function formatPrepareOutputs({ baseSha, version }) {
	return `base_sha=${baseSha}\nversion=${version}\n`;
}

const log = (line) => process.stdout.write(`[forced-prepare] ${line}\n`);

function main() {
	const { values } = parseArgs({
		options: {
			sha: { type: "string" },
			version: { type: "string" },
			"github-output": { type: "string" },
		},
	});
	if (!values["github-output"]) throw new Error("--github-output is required");
	if (values.version !== undefined && !VERSION_RE.test(values.version)) {
		throw new Error(`invalid --version ${JSON.stringify(values.version)} (expected YYYY.M.D or YYYY.M.D-N)`);
	}
	const capture = (bin, args) => execFileSync(bin, args, { encoding: "utf8" });
	const runCommand = (bin, args) => execFileSync(bin, args, { stdio: "inherit" });
	let baseSha;
	if (values.sha) {
		assertReleasableCommit(values.sha, runCommand, log, capture);
		baseSha = values.sha;
	} else {
		baseSha = capture("git", ["rev-parse", "HEAD"]).trim();
	}
	const version = values.version ?? computeNextVersion();
	log(`release version: ${version}`);
	// The base is resolved here, once: the matrix jobs and release.mjs --sha take this output and never look at main
	// again (release-train ruling on senpi#6642).
	if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new Error(`resolved base ${JSON.stringify(baseSha)} is not a full sha`);
	log(`base commit for every later job: ${baseSha}`);
	appendFileSync(values["github-output"], formatPrepareOutputs({ baseSha, version }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	try {
		main();
	} catch (error) {
		process.stderr.write(`[forced-prepare] error: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
