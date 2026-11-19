#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { failedPlatformJobs, PLATFORM_RED_LABEL, PLATFORM_RED_TITLE, PLATFORM_WORKFLOWS, releaseBlockers } from "./ci-platform-red.mjs";

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

// A stand-in `gh` that records every call and keeps the repository's issues in a state file, so the reporter runs end
// to end. `race` is an issue another report opens while this one is creating its own.
function fakeGh({ issues, race = null }) {
	const dir = mkdtempSync(join(tmpdir(), "ci-platform-red-"));
	roots.push(dir);
	const calls = join(dir, "calls.jsonl");
	const state = join(dir, "issues.json");
	writeFileSync(state, JSON.stringify(issues));
	writeFileSync(join(dir, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const issues = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
const save = () => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(issues));
const flag = (name) => args[args.indexOf(name) + 1];
const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
if (path.includes("/jobs")) process.stdout.write(JSON.stringify([{ jobs: ${JSON.stringify(jobs)} }]));
else if (path.includes("/pulls")) process.stdout.write(JSON.stringify([{ number: 6834 }]));
else if (args[0] === "issue" && args[1] === "list") {
	if (args.includes("--search")) throw new Error("the search index lags; list by label");
	process.stdout.write(JSON.stringify(issues.filter((issue) => issue.open && issue.labels.includes(flag("--label")))));
} else if (args[0] === "issue" && args[1] === "create") {
	const race = ${JSON.stringify(race)};
	if (race) issues.push(race);
	const number = Math.max(0, ...issues.map((issue) => issue.number)) + 1;
	issues.push({ number, title: flag("--title"), labels: [flag("--label")], open: true });
	save();
	process.stdout.write("https://github.com/owner/repo/issues/" + number + "\\n");
} else if (args[0] === "issue" && args[1] === "close") {
	issues.find((issue) => issue.number === Number(args[2])).open = false;
	save();
}
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
	const open = () => JSON.parse(readFileSync(state, "utf8")).filter((issue) => issue.open && issue.title === PLATFORM_RED_TITLE).map((issue) => issue.number);
	return { run, recorded, open };
}

const tracking = (number, open = true) => ({ number, title: PLATFORM_RED_TITLE, labels: [PLATFORM_RED_LABEL], open });
const bodyOf = (args) => args[args.indexOf("--body") + 1];

describe("ci-platform-red.mjs report (senpi#6834)", () => {
	it("opens the one labelled tracking issue, naming the merged PR, the run and each failed macOS/Windows job", () => {
		const gh = fakeGh({ issues: [{ number: 9, title: "Some other issue", labels: [PLATFORM_RED_LABEL], open: true }, tracking(5, false)] });
		const result = gh.run();
		assert.equal(result.status, 0, result.stderr);
		const create = gh.recorded().find((args) => args[0] === "issue" && args[1] === "create");
		assert.ok(create, JSON.stringify(gh.recorded()));
		assert.equal(create[create.indexOf("--title") + 1], PLATFORM_RED_TITLE);
		for (const text of ["#6834", "https://example.test/run/42", "macOS combined", "Read binary parity (windows-latest)", "b".repeat(40)]) {
			assert.ok(bodyOf(create).includes(text), text);
		}
		assert.ok(!bodyOf(create).includes("Static checks"));
		assert.deepEqual(gh.open(), [10]);
	});

	it("comments on the oldest open tracking issue instead of opening another", () => {
		const gh = fakeGh({ issues: [tracking(77), tracking(80)] });
		assert.equal(gh.run().status, 0);
		const calls = gh.recorded();
		assert.ok(!calls.some((args) => args[0] === "issue" && args[1] === "create"));
		const comment = calls.find((args) => args[0] === "issue" && args[1] === "comment");
		assert.equal(comment?.[2], "77");
		assert.ok(bodyOf(comment).includes("#6834"));
	});

	it("loses a race to open the issue without losing its report: it comments on the winner and closes its own", () => {
		const gh = fakeGh({ issues: [], race: tracking(1) });
		const result = gh.run();
		assert.equal(result.status, 0, result.stderr);
		const comment = gh.recorded().find((args) => args[0] === "issue" && args[1] === "comment");
		assert.equal(comment?.[2], "1");
		assert.ok(bodyOf(comment).includes("macOS combined"));
		assert.deepEqual(gh.open(), [1]);
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

	it("holds no concurrency group, so no pending report is ever replaced and dropped (review L1)", () => {
		assert.equal(workflow.concurrency, undefined);
		for (const job of Object.values(workflow.jobs)) assert.equal(job.concurrency, undefined);
	});
});
