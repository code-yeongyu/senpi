#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { failedPlatformJobs, PLATFORM_RED_TITLE, PLATFORM_WORKFLOWS, releaseBlockers } from "./ci-platform-red.mjs";

const script = fileURLToPath(new URL("./ci-platform-red.mjs", import.meta.url));
const workflow = parse(readFileSync(new URL("../.github/workflows/platform-red.yml", import.meta.url), "utf8"));
const roots = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const job = (name, labels, conclusion) => ({ name, labels, conclusion, html_url: `https://example.test/job/${name}` });
const jobs = [
	job("Static checks", ["ubuntu-latest"], "failure"),
	job("macOS combined", ["macos-latest"], "failure"),
	job("Hooks trust storage (Windows)", ["windows-latest"], "success"),
	job("Read binary parity (windows-latest)", ["windows-latest"], "failure"),
	job("Build native-prebuild-win32-arm64", ["windows-latest"], "cancelled"),
];

describe("failedPlatformJobs (senpi#6834)", () => {
	it("keeps only the failed jobs that ran on a macOS or Windows runner", () => {
		assert.deepEqual(failedPlatformJobs(jobs).map((entry) => entry.name), ["macOS combined", "Read binary parity (windows-latest)"]);
		assert.deepEqual(failedPlatformJobs([jobs[0], jobs[2]]), []);
	});
});

describe("releaseBlockers (senpi#6834)", () => {
	const run = (conclusion, failed = []) => ({ conclusion, html_url: "https://example.test/run/1", head_sha: "a".repeat(40), failedPlatformJobs: failed });

	it("blocks on a red default-branch run whose macOS/Windows legs failed, and on a lookup it could not make", () => {
		const blockers = releaseBlockers([
			{ file: "ci.yml", run: run("failure", [jobs[1]]) },
			{ file: "native-prebuilds.yml", error: "HTTP 502" },
			{ file: "session-worker-compile.yml", run: run("success") },
			{ file: "read-summary-binary-parity.yml", run: null },
		]);
		assert.equal(blockers.length, 2);
		assert.match(blockers[0], /ci\.yml.*macOS combined.*example\.test\/run\/1/);
		assert.match(blockers[1], /native-prebuilds\.yml.*HTTP 502/);
	});

	it("does not block on a red run whose platform legs all passed (a Linux-only red is the Check and test gate's)", () => {
		assert.deepEqual(releaseBlockers([{ file: "ci.yml", run: run("failure", []) }]), []);
	});
});

// A stand-in `gh` that records every call and answers the few it is asked, so the reporter runs end to end.
function fakeGh({ openIssues }) {
	const dir = mkdtempSync(join(tmpdir(), "ci-platform-red-"));
	roots.push(dir);
	const calls = join(dir, "calls.jsonl");
	writeFileSync(join(dir, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
if (path.includes("/jobs")) process.stdout.write(JSON.stringify([{ jobs: ${JSON.stringify(jobs)} }]));
else if (path.includes("/pulls")) process.stdout.write(JSON.stringify([{ number: 6834 }]));
else if (args[0] === "issue" && args[1] === "list") process.stdout.write(JSON.stringify(${JSON.stringify(openIssues)}));
`);
	chmodSync(join(dir, "gh"), 0o755);
	const run = () => spawnSync(process.execPath, [script, "report"], {
		encoding: "utf8",
		env: {
			...process.env,
			PATH: `${dir}:${process.env.PATH}`,
			GITHUB_REPOSITORY: "owner/repo",
			RUN_ID: "42",
			RUN_ATTEMPT: "1",
			RUN_URL: "https://example.test/run/42",
			WORKFLOW_NAME: "CI",
			HEAD_SHA: "b".repeat(40),
		},
	});
	const recorded = () => readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	return { run, recorded };
}

describe("ci-platform-red.mjs report (senpi#6834)", () => {
	it("opens the one tracking issue, naming the merged PR, the run and each failed macOS/Windows job", () => {
		const gh = fakeGh({ openIssues: [{ number: 9, title: "Some other issue" }] });
		const result = gh.run();
		assert.equal(result.status, 0, result.stderr);
		const create = gh.recorded().find((args) => args[0] === "issue" && args[1] === "create");
		assert.ok(create, JSON.stringify(gh.recorded()));
		assert.equal(create[create.indexOf("--title") + 1], PLATFORM_RED_TITLE);
		const body = create[create.indexOf("--body") + 1];
		for (const text of ["#6834", "https://example.test/run/42", "macOS combined", "Read binary parity (windows-latest)", "b".repeat(40)]) {
			assert.ok(body.includes(text), text);
		}
		assert.ok(!body.includes("Static checks"));
	});

	it("comments on the open tracking issue instead of opening a second one", () => {
		const gh = fakeGh({ openIssues: [{ number: 9, title: "Some other issue" }, { number: 77, title: PLATFORM_RED_TITLE }] });
		assert.equal(gh.run().status, 0);
		const calls = gh.recorded();
		assert.ok(!calls.some((args) => args[0] === "issue" && args[1] === "create"));
		const comment = calls.find((args) => args[0] === "issue" && args[1] === "comment");
		assert.equal(comment?.[2], "77");
		assert.ok(comment[comment.indexOf("--body") + 1].includes("#6834"));
	});
});

describe("platform-red.yml", () => {
	it("reacts to the completed default-branch runs of every workflow with macOS/Windows legs, and only to failed pushes from this repository", () => {
		assert.deepEqual([...workflow.on.workflow_run.workflows].sort(), Object.values(PLATFORM_WORKFLOWS).sort());
		assert.deepEqual(workflow.on.workflow_run.types, ["completed"]);
		const [report] = Object.values(workflow.jobs);
		for (const condition of ["workflow_run.conclusion == 'failure'", "workflow_run.event == 'push'", "workflow_run.head_branch == 'main'", "head_repository.full_name == github.repository"]) {
			assert.ok(report.if.includes(condition), condition);
		}
		assert.equal(report.permissions.issues, "write");
	});
});
