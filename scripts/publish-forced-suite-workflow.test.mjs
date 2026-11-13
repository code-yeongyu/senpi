#!/usr/bin/env node
// senpi#6642: with force_tests the release's suite runs as matrix jobs in publish-npm.yml (prepare, coding-agent shards
// 1..N, rest) on the prepared commit, and the publishing release job is gated on all of them. Release and publish
// identity contract: npm trusted publishing binds this workflow file and its release job.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FORCED_SHARD_JOBS } from "./release-forced-test-suite.mjs";
import { evaluateExpression, isTruthy, jobExpression, jobStep, jobSteps, workflowJob } from "./workflow-text.test-support.mjs";

const workflow = readFileSync(new URL("../.github/workflows/publish-npm.yml", import.meta.url), "utf8");
const MATRIX_JOBS = ["prepare", "forced-rest", "forced-shard"];
const TESTED_JOBS = ["forced-rest", "forced-shard"];
const SHARED_SETUP = [
	"Download the tested commit",
	"Check out the tested commit",
	"Setup Node.js",
	"Setup Bun",
	"Assert bun 1.4 toolchain",
	"Install dependencies",
	"Provision ripgrep and fd",
	"Build all workspaces (so husky pre-commit type check resolves)",
	"Reset auto-generated and npm-install drift files (not part of release diff)",
	"Setup Rust",
	"Cache Rust",
	"Build native grep addon",
];
const PREPARE_SETUP = [
	"Configure git identity",
	"Setup Node.js",
	"Setup Bun",
	"Assert bun 1.4 toolchain",
	"Install dependencies",
	"Build all workspaces (so husky pre-commit type check resolves)",
	"Reset auto-generated and npm-install drift files (not part of release diff)",
];

/** The shard indices of the forced-shard matrix, read from a workflow's text. */
function shardMatrix(text) {
	const list = workflowJob(text, "forced-shard").match(/\n {8}shard: \[([^\]]*)\]\n/)?.[1];
	assert.ok(list, "expected a shard matrix list");
	return list.split(",").map((entry) => Number(entry.trim()));
}

const assertExactShards = (text) =>
	assert.deepEqual(shardMatrix(text), Array.from({ length: FORCED_SHARD_JOBS }, (_, index) => index + 1));

describe("forced-suite matrix jobs (senpi#6642)", () => {
	it("runs coding-agent shards exactly 1..N, N the suite script's FORCED_SHARD_JOBS, each passing its index", () => {
		assertExactShards(workflow);
		const job = workflowJob(workflow, "forced-shard");
		assert.match(job, /--part "\$\{\{ matrix\.shard \}\}"/);
		assert.match(workflowJob(workflow, "forced-rest"), /--part rest/);
	});

	it("turns red when a shard index is dropped from the matrix", () => {
		const dropped = workflow.replace(/(\n {8}shard: \[[^\]]*), \d+\]/, "$1]");
		assert.notEqual(dropped, workflow);
		assert.throws(() => assertExactShards(dropped));
	});

	it("checks out the prepare job's tested_sha in every shard job and the release job, never github.sha or the dispatched ref", () => {
		for (const name of TESTED_JOBS) {
			const job = workflowJob(workflow, name);
			assert.doesNotMatch(job, /github\.sha|github\.ref|inputs\.sha/, `${name} reads the dispatched commit`);
			assert.match(jobStep(job, "Checkout"), /ref: \$\{\{ needs\.prepare\.outputs\.base_sha \}\}/);
		}
		for (const name of [...TESTED_JOBS, "release"]) {
			const step = jobStep(workflowJob(workflow, name), "Check out the tested commit");
			assert.match(step, /TESTED_SHA: \$\{\{ needs\.prepare\.outputs\.tested_sha \}\}/);
			assert.match(step, /git checkout -B main "\$TESTED_SHA"/);
		}
		const release = workflowJob(workflow, "release");
		assert.ok(
			release.indexOf("- name: Check out the tested commit") < release.indexOf("- name: Install dependencies"),
			"the release job installs and builds the tested commit",
		);
		const run = jobStep(release, "Run release");
		assert.match(run, /TESTED_SHA: \$\{\{ needs\.prepare\.outputs\.tested_sha \}\}/);
		assert.match(run, /--tested-sha "\$TESTED_SHA" --shard-results "\$FORCED_SUITE_RESULTS"/);
		assert.doesNotMatch(run, /--force-tests/);
	});

	it("the tested-commit step lands a shallow checkout of the dispatched commit on the bundled tested commit", () => {
		const script = jobStep(workflowJob(workflow, "forced-shard"), "Check out the tested commit")
			.match(/run: \|\n([\s\S]*)/)?.[1]
			.replace(/^ {10}/gm, "");
		assert.ok(script, "expected the step script");
		const root = mkdtempSync(join(tmpdir(), "tested-checkout-"));
		const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
		try {
			const source = join(root, "source");
			mkdirSync(source);
			git(source, "init", "-q", "-b", "main");
			const commit = (message) => {
				writeFileSync(join(source, "f"), message);
				git(source, "add", "f");
				git(source, "-c", "user.name=t", "-c", "user.email=t@e", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
				return git(source, "rev-parse", "HEAD");
			};
			const base = commit("base");
			const tested = commit("catalog");
			git(source, "update-ref", "refs/forced-suite/tested", tested);
			const bundle = join(root, "tested-commit.bundle");
			git(source, "bundle", "create", "-q", bundle, "refs/forced-suite/tested", `^${base}`);
			git(source, "reset", "-q", "--hard", base);
			const checkout = (name, testedSha, bundlePath) => {
				const clone = join(root, name);
				git(root, "clone", "-q", "--depth", "1", `file://${source}`, clone);
				const result = spawnSync("bash", ["-c", script], {
					cwd: clone,
					env: { PATH: process.env.PATH, TESTED_SHA: testedSha, TESTED_BUNDLE: bundlePath },
					encoding: "utf8",
				});
				return { result, head: git(clone, "rev-parse", "HEAD"), branch: git(clone, "branch", "--show-current") };
			};
			const changed = checkout("changed", tested, bundle);
			assert.equal(changed.result.status, 0, changed.result.stderr);
			assert.deepEqual([changed.head, changed.branch], [tested, "main"]);
			const unchanged = checkout("unchanged", base, join(root, "absent.bundle"));
			assert.equal(unchanged.result.status, 0, unchanged.result.stderr);
			assert.equal(unchanged.head, base);
			const missing = checkout("missing", tested, join(root, "absent.bundle"));
			assert.notEqual(missing.result.status, 0, "a tested commit nobody bundled was checked out");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("gates the release job on exact success of prepare, rest and every shard only when force_tests is set", () => {
		const condition = jobExpression(workflowJob(workflow, "release"), "if");
		const runs = ({ publishOnly = false, forceTests = false, ready = "", prepare = "skipped", rest = "skipped", shard = "skipped" }) =>
			isTruthy(
				evaluateExpression(condition, {
					inputs: { "publish-only": publishOnly, force_tests: forceTests },
					needs: {
						"native-prebuilds": { result: publishOnly ? "success" : "skipped", outputs: { ready } },
						prepare: { result: prepare, outputs: {} },
						"forced-rest": { result: rest, outputs: {} },
						"forced-shard": { result: shard, outputs: {} },
					},
				}),
			);
		assert.equal(runs({}), true, "a release without force_tests must still run with the matrix skipped");
		assert.equal(runs({ publishOnly: true, ready: "true" }), true, "publish-only must still run");
		assert.equal(runs({ publishOnly: true, ready: "true", forceTests: true }), true, "publish-only ignores force_tests");
		assert.equal(runs({ publishOnly: true, ready: "" }), false);
		const green = { forceTests: true, prepare: "success", rest: "success", shard: "success" };
		assert.equal(runs(green), true);
		for (const job of ["prepare", "rest", "shard"]) {
			for (const result of ["failure", "cancelled", "skipped"]) {
				assert.equal(runs({ ...green, [job]: result }), false, `the release ran with ${job} ${result}`);
			}
		}
		assert.match(workflowJob(workflow, "release"), /\n    needs: \[native-prebuilds, prepare, forced-rest, forced-shard\]\n/);
	});

	it("keeps the publishing release job and its identity in publish-npm.yml", () => {
		assert.match(workflow, /^name: Release\n/);
		assert.match(workflow, /\npermissions:\n  actions: read\n  contents: read\n  id-token: write\n/);
		const release = workflowJob(workflow, "release");
		assert.match(release, /node scripts\/publish\.mjs/);
		assert.doesNotMatch(release, /\n    environment:/, "the release job gained an environment trusted publishing does not expect");
		assert.doesNotMatch(release, /\n    permissions:/, "the release job's permissions changed");
		for (const name of MATRIX_JOBS) assert.doesNotMatch(workflowJob(workflow, name), /scripts\/publish\.mjs|npm publish/);
	});

	it("gives the new jobs read-only contents permission and no secrets", () => {
		for (const name of MATRIX_JOBS) {
			const job = workflowJob(workflow, name);
			assert.match(job, /\n    permissions:\n      contents: read\n(?! {6}\S)/, `${name} must have exactly contents: read`);
			assert.doesNotMatch(job, /id-token|: write|secrets\./, `${name} must not get write access or secrets`);
		}
	});

	it("runs every shard to the end (fail-fast false), at about 40 min each and 110 min end to end", () => {
		assert.match(workflowJob(workflow, "forced-shard"), /\n    strategy:\n      fail-fast: false\n/);
		const minutes = (name) => Number(workflowJob(workflow, name).match(/\n    timeout-minutes: (\d+)\n/)?.[1]);
		for (const name of TESTED_JOBS) {
			assert.ok(minutes(name) >= 35 && minutes(name) <= 45, `${name} timeout ${minutes(name)} is not about 40 min`);
		}
		const release = workflowJob(workflow, "release");
		const releaseMinutes = (inputs) => evaluateExpression(jobExpression(release, "timeout-minutes"), { inputs });
		assert.equal(releaseMinutes({ force_tests: false, "publish-only": false }), 60, "the default release timeout changed");
		assert.equal(releaseMinutes({ force_tests: false, "publish-only": true }), 60, "the publish-only timeout changed");
		assert.equal(releaseMinutes({ force_tests: true, "publish-only": true }), 180, "the publish-only timeout changed");
		const total = minutes("prepare") + Math.max(...TESTED_JOBS.map(minutes)) + releaseMinutes({ force_tests: true, "publish-only": false });
		assert.ok(total <= 110, `a forced release can run ${total} min`);
	});

	it("sets up the shard, rest and prepare jobs from the release job's own step definitions (no drift)", () => {
		const release = workflowJob(workflow, "release");
		const releaseStep = (name) => jobStep(release, name);
		for (const name of TESTED_JOBS) {
			const job = workflowJob(workflow, name);
			for (const step of SHARED_SETUP) assert.equal(jobStep(job, step), releaseStep(step), `${name}: ${step} drifted`);
			const order = jobSteps(job).map((step) => step.name).filter((step) => SHARED_SETUP.includes(step));
			assert.deepEqual(order, SHARED_SETUP, `${name} runs the shared setup out of order`);
		}
		const prepare = workflowJob(workflow, "prepare");
		for (const step of PREPARE_SETUP) assert.equal(jobStep(prepare, step), releaseStep(step), `prepare: ${step} drifted`);
	});

	// Release-train ruling on senpi#6642: with force_tests the release takes its base only from prepare's base_sha
	// output, even when the dispatch named a sha; without force_tests the dispatched sha passes through as before.
	it("passes release.mjs prepare's base_sha as --sha under force_tests, and the dispatched sha otherwise", () => {
		const step = jobStep(workflowJob(workflow, "release"), "Run release");
		const script = step.match(/run: \|\n([\s\S]*)/)?.[1].replace(/^ {10}/gm, "");
		assert.ok(script, "expected the Run release script");
		const root = mkdtempSync(join(tmpdir(), "run-release-"));
		try {
			const bin = join(root, "bin");
			mkdirSync(bin);
			const calls = join(root, "npm-args.json");
			writeFileSync(join(bin, "npm"), `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)));\n`);
			writeFileSync(join(bin, "git"), "#!/bin/sh\nexit 0\n");
			for (const name of ["npm", "git"]) chmodSync(join(bin, name), 0o755);
			const argsFor = ({ forceTests, releaseSha }) => {
				const rendered = script
					.replaceAll("${{ inputs.force_tests }}", String(forceTests))
					.replaceAll("${{ inputs.dry_run }}", "true");
				assert.doesNotMatch(rendered, /\$\{\{/, "unrendered expression in the Run release script");
				const result = spawnSync("bash", ["-c", rendered], {
					cwd: root,
					env: {
						PATH: `${bin}:${process.env.PATH}`,
						GH_TOKEN: "t",
						GITHUB_REPOSITORY: "o/r",
						RELEASE_SHA: releaseSha,
						RELEASE_VERSION: "2026.11.13",
						TESTED_SHA: "c".repeat(40),
						TESTED_BASE_SHA: "b".repeat(40),
						FORCED_SUITE_RESULTS: "/results",
					},
					encoding: "utf8",
				});
				assert.equal(result.status, 0, result.stderr);
				return JSON.parse(readFileSync(calls, "utf8"));
			};
			const shaArgs = (args) => args.flatMap((arg, index) => (arg === "--sha" ? [args[index + 1]] : []));
			for (const releaseSha of ["", "a".repeat(40)]) {
				const forced = argsFor({ forceTests: true, releaseSha });
				assert.deepEqual(shaArgs(forced), ["b".repeat(40)], `force_tests with inputs.sha=${releaseSha || "(empty)"}`);
				assert.deepEqual(forced.slice(forced.indexOf("--tested-sha"), forced.indexOf("--tested-sha") + 4), [
					"--tested-sha",
					"c".repeat(40),
					"--shard-results",
					"/results",
				]);
			}
			assert.deepEqual(shaArgs(argsFor({ forceTests: false, releaseSha: "a".repeat(40) })), ["a".repeat(40)]);
			const plain = argsFor({ forceTests: false, releaseSha: "" });
			assert.deepEqual(shaArgs(plain), []);
			assert.equal(plain.includes("--tested-sha"), false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reads the base only from prepare's base_sha output in every job after prepare", () => {
		for (const name of TESTED_JOBS) {
			assert.doesNotMatch(workflowJob(workflow, name), /inputs\.sha|github\.sha|github\.ref|origin\/main/, name);
		}
		const prepare = jobStep(workflowJob(workflow, "prepare"), "Regenerate the model catalog on the release commit");
		assert.match(prepare, /--github-output "\$GITHUB_OUTPUT"/);
		const release = jobStep(workflowJob(workflow, "release"), "Run release");
		assert.match(release, /TESTED_BASE_SHA: \$\{\{ needs\.prepare\.outputs\.base_sha \}\}/);
	});

	it("prepares the release's version and tested commit once and hands them to the release job", () => {
		const prepare = workflowJob(workflow, "prepare");
		for (const output of ["base_sha", "tested_sha", "tested_tree", "version", "bundle"]) {
			assert.match(prepare, new RegExp(`\\n      ${output}: \\$\\{\\{ steps\\.prepare\\.outputs\\.${output} \\}\\}\\n`));
		}
		assert.match(jobExpression(prepare, "if"), /inputs\.force_tests == true && inputs\.publish-only != true/);
		assert.match(jobStep(prepare, "Regenerate the model catalog on the release commit"), /node scripts\/release-forced-prepare\.mjs/);
		const run = jobStep(workflowJob(workflow, "release"), "Run release");
		assert.match(run, /RELEASE_VERSION: \$\{\{ inputs\.version \|\| needs\.prepare\.outputs\.version \}\}/);
	});
});
