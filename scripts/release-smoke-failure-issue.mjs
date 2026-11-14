#!/usr/bin/env node
/**
 * Build Binaries dispatches the npm publish without waiting for the standalone-binary smoke (senpi#6627).
 * When that smoke then fails on a runner while npm already published the version, this opens an issue naming
 * the version and each failing OS, with the one command the release owner runs to point npm `latest` back at
 * the previous version, and exits non-zero so the run fails loudly. It never changes a dist-tag itself.
 *
 *   node scripts/release-smoke-failure-issue.mjs [--dry-run]
 *
 * Env: RELEASE_TAG (vX), GH_REPO, RUN_ID, RUN_ATTEMPT, RUN_URL. `--dry-run` prints the issue instead of
 * opening it and exits 0.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const NPM_PACKAGE = "@code-yeongyu/senpi";
const SMOKE_JOB = /^smoke-test-binaries \((.+)\)$/;
const FAILED = new Set(["failure", "timed_out"]);

/** The runner labels of the smoke matrix rows that failed, from the run's jobs (`{name, conclusion}`). */
export function failedSmokeRunners(jobs) {
	return jobs
		.map((job) => ({ runner: SMOKE_JOB.exec(job.name)?.[1], conclusion: job.conclusion }))
		.filter((job) => job.runner && FAILED.has(job.conclusion))
		.map((job) => job.runner)
		.sort();
}

/** The version npm published right before `version`, by publish time (`npm view <pkg> time --json`). */
export function previousVersion(publishTimes, version) {
	const published = Object.entries(publishTimes)
		.filter(([key]) => key !== "created" && key !== "modified")
		.sort(([, left], [, right]) => Date.parse(left) - Date.parse(right))
		.map(([key]) => key);
	const index = published.indexOf(version);
	return index > 0 ? published[index - 1] : null;
}

/** The issue the release owner acts on. */
export function smokeFailureIssue({ version, previous, runners, runUrl }) {
	const target = previous ?? "<previous>";
	const os = runners.length > 0 ? runners.join(", ") : "an unidentified runner";
	return {
		title: `Release ${version}: standalone-binary smoke failed on ${os} after npm published it`,
		body: [
			`Build Binaries for v${version} published \`${NPM_PACKAGE}@${version}\` to npm, and then the standalone-binary smoke (\`--help\` / \`--version\`) failed on: ${os}.`,
			"",
			`Run: ${runUrl}`,
			"",
			"The GitHub Release for this tag stays unpublished. npm `latest` still points at this version.",
			"",
			"If the failure is a real startup bug that npm users would also hit, point npm `latest` back at the last known-good version.",
			`The version published right before this one was ${previous ? `\`${previous}\`` : "not readable from npm"}; if that release was itself rolled back, use the newest version before it that was not:`,
			"",
			"```sh",
			`npm dist-tag add ${NPM_PACKAGE}@${target} latest`,
			"```",
			...(previous ? [] : ["", "The previous version could not be read from npm; replace `<previous>` with it."]),
			"",
			"Then fix the binary, cut a new release, and close this issue.",
		].join("\n"),
	};
}

function run(bin, args) {
	const result = spawnSync(bin, args, { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`${bin} ${args.join(" ")} failed: ${result.stderr.trim()}`);
	return result.stdout;
}

function main() {
	const dryRun = process.argv.includes("--dry-run");
	const { RELEASE_TAG, GH_REPO, RUN_ID, RUN_ATTEMPT, RUN_URL } = process.env;
	if (!RELEASE_TAG || !GH_REPO || !RUN_ID || !RUN_URL) throw new Error("RELEASE_TAG, GH_REPO, RUN_ID and RUN_URL are required");
	const version = RELEASE_TAG.replace(/^v/, "");
	const jobsPath = `repos/${GH_REPO}/actions/runs/${RUN_ID}/attempts/${RUN_ATTEMPT || 1}/jobs`;
	const jobs = JSON.parse(run("gh", ["api", "--paginate", "--slurp", jobsPath])).flatMap((page) => page.jobs);
	const previous = previousVersion(JSON.parse(run("npm", ["view", NPM_PACKAGE, "time", "--json"])), version);
	const issue = smokeFailureIssue({ version, previous, runners: failedSmokeRunners(jobs), runUrl: RUN_URL });
	if (dryRun) {
		process.stdout.write(`[dry-run] would open: ${issue.title}\n\n${issue.body}\n`);
		return 0;
	}
	const dir = mkdtempSync(join(tmpdir(), "smoke-failure-"));
	try {
		writeFileSync(join(dir, "body.md"), issue.body);
		process.stdout.write(run("gh", ["issue", "create", "--repo", GH_REPO, "--title", issue.title, "--body-file", join(dir, "body.md")]));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	process.stderr.write(`::error::${issue.title}\n`);
	return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();
