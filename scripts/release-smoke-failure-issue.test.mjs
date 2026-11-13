#!/usr/bin/env node
// senpi#6628 review M1 (LEAD ruling b): npm no longer waits for the standalone-binary smoke, so a smoke that fails
// after npm published opens an issue naming the version, each failing OS and the one-command npm rollback, and
// fails the run. No job moves a dist-tag.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanupFakes, fakeBin } from "./build-binaries-release-recovery.test-support.mjs";
import { failedSmokeRunners, previousVersion, smokeFailureIssue } from "./release-smoke-failure-issue.mjs";

afterEach(cleanupFakes);

const script = fileURLToPath(new URL("./release-smoke-failure-issue.mjs", import.meta.url));
const workflow = readFileSync(new URL("../.github/workflows/build-binaries.yml", import.meta.url), "utf8");
const JOB = "report-smoke-failure-after-npm";
const ROLLBACK = "npm dist-tag add @code-yeongyu/senpi@2026.11.12 latest";

const job = (name, conclusion) => ({ name, conclusion });
const JOBS = [
	job("build", "success"),
	job("smoke-test-binaries (ubuntu-latest)", "success"),
	job("smoke-test-binaries (macos-latest)", "failure"),
	job("smoke-test-binaries (windows-latest)", "timed_out"),
	job("publish-npm", "success"),
];
const TIMES = {
	created: "2026-01-01T00:00:00Z",
	modified: "2026-11-13T17:00:00Z",
	"2026.11.11": "2026-11-11T21:09:35Z",
	"2026.11.10-3": "2026-11-11T09:00:00Z",
	"2026.11.12": "2026-11-12T05:21:11Z",
	"2026.11.13": "2026-11-13T16:59:41Z",
};

/** The text of one top-level job in build-binaries.yml. */
function jobText(name) {
	const lines = workflow.split("\n");
	const start = lines.indexOf(`  ${name}:`);
	assert.ok(start >= 0, `no job ${name}`);
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => /^ {2}[\w-]+:\s*$/.test(line) || /^\S/.test(line));
	return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

describe("smoke failure after npm: issue content (senpi#6628)", () => {
	it("names every failed or timed-out smoke row, and no passed, cancelled or non-smoke job", () => {
		assert.deepEqual(failedSmokeRunners(JOBS), ["macos-latest", "windows-latest"]);
		assert.deepEqual(failedSmokeRunners([...JOBS.slice(0, 2), job("smoke-test-binaries (macos-latest)", "cancelled")]), []);
	});

	it("reads the previous version by publish time, so a later -N cut is not mistaken for an older one", () => {
		assert.equal(previousVersion(TIMES, "2026.11.13"), "2026.11.12");
		assert.equal(previousVersion(TIMES, "2026.11.11"), "2026.11.10-3");
		assert.equal(previousVersion(TIMES, "2026.11.10-3"), null, "the first version has no previous");
		assert.equal(previousVersion(TIMES, "2026.11.14"), null, "an unpublished version has no previous");
	});

	it("carries the version, each failing OS, the run and the exact rollback command", () => {
		const issue = smokeFailureIssue({ version: "2026.11.13", previous: "2026.11.12", runners: ["macos-latest", "windows-latest"], runUrl: "https://run/1" });
		assert.match(issue.title, /2026\.11\.13/);
		assert.match(issue.title, /macos-latest, windows-latest/);
		assert.ok(issue.body.includes(ROLLBACK), issue.body);
		assert.ok(issue.body.includes("https://run/1"));
		assert.match(issue.body, /last known-good version/);
		assert.match(issue.body, /published right before this one was `2026\.11\.12`; if that release was itself rolled back/);
		const unknown = smokeFailureIssue({ version: "2026.11.13", previous: null, runners: ["macos-latest"], runUrl: "u" });
		assert.ok(unknown.body.includes("npm dist-tag add @code-yeongyu/senpi@<previous> latest"));
		assert.match(unknown.body, /replace `<previous>`/);
	});
});

describe("smoke failure after npm: the script (senpi#6628)", () => {
	function runIssueScript(args) {
		const gh = fakeBin("gh", `echo "$*" >> "$LOG"\ncase "$1" in\n  api) cat "$JOBS_FILE" ;;\n  issue) echo https://github.com/o/r/issues/7 ;;\n  *) exit 2 ;;\nesac`);
		const npm = fakeBin("npm", `echo "$*" >> "$LOG"\ncat "$TIMES_FILE"`);
		writeFileSync(join(gh.root, "jobs.json"), JSON.stringify([{ jobs: JOBS }]));
		writeFileSync(join(npm.root, "times.json"), JSON.stringify(TIMES));
		const result = spawnSync(process.execPath, [script, ...args], {
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${gh.root}:${npm.root}:${process.env.PATH}`,
				JOBS_FILE: join(gh.root, "jobs.json"),
				TIMES_FILE: join(npm.root, "times.json"),
				RELEASE_TAG: "v2026.11.13",
				GH_REPO: "o/r",
				RUN_ID: "42",
				RUN_ATTEMPT: "2",
				RUN_URL: "https://run/42",
			},
		});
		return { result, gh: gh.calls(), npm: npm.calls() };
	}

	it("opens the issue and exits non-zero", () => {
		const { result, gh, npm } = runIssueScript([]);
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /::error::Release 2026\.11\.13: .*macos-latest, windows-latest/);
		assert.deepEqual(gh[0], "api --paginate --slurp repos/o/r/actions/runs/42/attempts/2/jobs");
		assert.match(gh[1], /^issue create --repo o\/r --title Release 2026\.11\.13: standalone-binary smoke failed on macos-latest, windows-latest/);
		assert.deepEqual(npm, ["view @code-yeongyu/senpi time --json"]);
		assert.ok(!gh.concat(npm).some((call) => /dist-tag/.test(call)), "the script must never move a dist-tag");
	});

	it("prints the issue under --dry-run without opening it", () => {
		const { result, gh } = runIssueScript(["--dry-run"]);
		assert.equal(result.status, 0, result.stderr);
		assert.ok(result.stdout.includes(ROLLBACK), result.stdout);
		assert.equal(gh.length, 1, "dry run only reads the run's jobs");
	});
});

describe("build-binaries.yml reports a smoke failure after npm (senpi#6628)", () => {
	const text = jobText(JOB);

	it("runs only when the smoke failed and npm published, never on a dry run", () => {
		assert.match(text, /\n {4}needs:\n {6}- smoke-test-binaries\n {6}- publish-npm\n/);
		const condition = /\n {4}if: \$\{\{ (.*) \}\}\n/.exec(text)?.[1];
		assert.equal(
			condition,
			"always() && inputs.dry_run != true && needs.publish-npm.result == 'success' && needs.smoke-test-binaries.result == 'failure'",
		);
	});

	it("passes the run, its attempt and its URL to the issue script", () => {
		assert.match(text, /\n {8}run: node scripts\/release-smoke-failure-issue\.mjs\n/);
		for (const key of ["RUN_ID: \\$\\{\\{ github\\.run_id \\}\\}", "RUN_ATTEMPT: \\$\\{\\{ github\\.run_attempt \\}\\}", "RUN_URL:", "GH_TOKEN: \\$\\{\\{ secrets\\.GITHUB_TOKEN \\}\\}"]) {
			assert.match(text, new RegExp(`\\n {10}${key}`));
		}
	});

	it("has the minimum permissions its steps need (contents: read for the checkout), and no other job can write issues", () => {
		assert.match(text, /uses: actions\/checkout@/, "the job checks out the release scripts, so it needs contents: read");
		assert.match(text, /\n {4}permissions:\n {6}actions: read\n {6}contents: read\n {6}issues: write\n {4}env:/);
		assert.match(workflow, /\npermissions: \{\}\n/);
		assert.equal(workflow.match(/issues: write/g).length, 1);
		const commands = workflow.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
		assert.ok(!/dist-tag/.test(commands), "no job may move an npm dist-tag");
	});

	it("blocks nothing: no other job waits for it", () => {
		assert.equal(workflow.split(`- ${JOB}`).length - 1, 0);
		assert.ok(!new RegExp(`needs:.*${JOB}`).test(workflow));
	});
});
