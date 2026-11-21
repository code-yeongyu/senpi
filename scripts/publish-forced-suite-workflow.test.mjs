#!/usr/bin/env node
// senpi#6642: with force_tests the release's suite runs as matrix jobs in publish-npm.yml (coding-agent shards 1..N,
// rest) on the commit the first-minute preflight resolved, and the publishing release job is gated on all of them. Release and publish
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
const MATRIX_JOBS = ["preflight", "forced-rest", "forced-shard"];
const TESTED_JOBS = ["forced-rest", "forced-shard"];
const SHARED_SETUP = [
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
const PREFLIGHT_SETUP = ["Setup Node.js"];

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

	it("checks out the preflight job's base_sha in every shard job and the release job, never github.sha or the dispatched ref", () => {
		for (const name of TESTED_JOBS) {
			const job = workflowJob(workflow, name);
			assert.doesNotMatch(job, /github\.sha|github\.ref|inputs\.sha/, `${name} reads the dispatched commit`);
			assert.match(jobStep(job, "Checkout"), /ref: \$\{\{ needs\.preflight\.outputs\.base_sha \}\}/);
		}
		for (const name of [...TESTED_JOBS, "release"]) {
			const step = jobStep(workflowJob(workflow, name), "Check out the tested commit");
			assert.match(step, /TESTED_SHA: \$\{\{ needs\.preflight\.outputs\.base_sha \}\}/);
			assert.match(step, /git checkout -B main "\$TESTED_SHA"/);
		}
		const release = workflowJob(workflow, "release");
		assert.ok(
			release.indexOf("- name: Check out the tested commit") < release.indexOf("- name: Install dependencies"),
			"the release job installs and builds the tested commit",
		);
		const run = jobStep(release, "Run release");
		assert.match(run, /TESTED_SHA: \$\{\{ needs\.preflight\.outputs\.base_sha \}\}/);
		assert.match(run, /--sha "\$TESTED_SHA" --shard-results "\$FORCED_SUITE_RESULTS"/);
		assert.doesNotMatch(run, /--force-tests/);
	});

	it("the tested-commit step names the checked-out base commit main and refuses a commit it does not have", () => {
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
			writeFileSync(join(source, "f"), "base");
			git(source, "add", "f");
			git(source, "-c", "user.name=t", "-c", "user.email=t@e", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base");
			const base = git(source, "rev-parse", "HEAD");
			const checkout = (name, testedSha) => {
				const clone = join(root, name);
				git(root, "clone", "-q", "--depth", "1", `file://${source}`, clone);
				git(clone, "checkout", "-q", "--detach", "HEAD");
				const result = spawnSync("bash", ["-c", script], { cwd: clone, env: { PATH: process.env.PATH, TESTED_SHA: testedSha }, encoding: "utf8" });
				return { result, head: git(clone, "rev-parse", "HEAD"), branch: git(clone, "branch", "--show-current") };
			};
			const landed = checkout("landed", base);
			assert.equal(landed.result.status, 0, landed.result.stderr);
			assert.deepEqual([landed.head, landed.branch], [base, "main"]);
			const missing = checkout("missing", "e".repeat(40));
			assert.notEqual(missing.result.status, 0, "a commit the checkout does not have was checked out");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("gates the release job on the preflight outside publish-only, and on rest and every shard only when force_tests is set", () => {
		const condition = jobExpression(workflowJob(workflow, "release"), "if");
		const runs = ({ publishOnly = false, forceTests = false, ready = "", preflight = "success", rest = "skipped", shard = "skipped" }) =>
			isTruthy(
				evaluateExpression(condition, {
					inputs: { "publish-only": publishOnly, force_tests: forceTests },
					needs: {
						"native-prebuilds": { result: publishOnly ? "success" : "skipped", outputs: { ready } },
						preflight: { result: preflight, outputs: {} },
						"forced-rest": { result: rest, outputs: {} },
						"forced-shard": { result: shard, outputs: {} },
					},
				}),
			);
		assert.equal(runs({}), true, "a release without force_tests must still run with the matrix skipped");
		for (const result of ["failure", "cancelled", "skipped"]) {
			assert.equal(runs({ preflight: result }), false, `the release ran with preflight ${result}`);
		}
		assert.equal(runs({ publishOnly: true, ready: "true", preflight: "skipped" }), true, "publish-only must still run");
		assert.equal(runs({ publishOnly: true, ready: "true", preflight: "skipped", forceTests: true }), true, "publish-only ignores force_tests");
		assert.equal(runs({ publishOnly: true, ready: "", preflight: "skipped" }), false);
		const green = { forceTests: true, rest: "success", shard: "success" };
		assert.equal(runs(green), true);
		for (const job of ["preflight", "rest", "shard"]) {
			for (const result of ["failure", "cancelled", "skipped"]) {
				assert.equal(runs({ ...green, [job]: result }), false, `the release ran with ${job} ${result}`);
			}
		}
		assert.match(workflowJob(workflow, "release"), /\n    needs: \[native-prebuilds, preflight, forced-rest, forced-shard\]\n/);
		const jobRuns = (name, forceTests, publishOnly) =>
			isTruthy(evaluateExpression(jobExpression(workflowJob(workflow, name), "if"), { inputs: { force_tests: forceTests, "publish-only": publishOnly } }));
		assert.deepEqual(
			[jobRuns("preflight", true, false), jobRuns("preflight", false, false), jobRuns("preflight", true, true), jobRuns("preflight", false, true)],
			[true, true, false, false],
			"preflight runs for every dispatch but publish-only",
		);
		for (const name of TESTED_JOBS) {
			assert.deepEqual(
				[jobRuns(name, true, false), jobRuns(name, false, false), jobRuns(name, true, true), jobRuns(name, false, true)],
				[true, false, false, false],
				`${name} runs only for force_tests outside publish-only`,
			);
		}
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

	it("gives the matrix jobs and require-version read-only contents permission and no secrets", () => {
		for (const name of [...TESTED_JOBS, "require-version"]) {
			const job = workflowJob(workflow, name);
			assert.match(job, /\n    permissions:\n      contents: read\n(?! {6}\S)/, `${name} must have exactly contents: read`);
			assert.doesNotMatch(job, /id-token|: write|secrets\./, `${name} must not get write access or secrets`);
		}
	});

	it("gives the preflight read-only permissions and only whether the push token is set, never its value", () => {
		const job = workflowJob(workflow, "preflight");
		assert.match(job, /\n    permissions:\n      actions: read\n      checks: read\n      contents: read\n(?! {6}\S)/);
		assert.doesNotMatch(job, /id-token|: write/);
		assert.deepEqual(job.match(/secrets\.[^}]*/g), ["secrets.UPSTREAM_AUTOMATION_TOKEN != '' "]);
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
		const total = minutes("preflight") + Math.max(...TESTED_JOBS.map(minutes)) + releaseMinutes({ force_tests: true, "publish-only": false });
		assert.ok(total <= 110, `a forced release can run ${total} min`);
	});

	it("sets up the shard, rest and preflight jobs from the release job's own step definitions (no drift)", () => {
		const release = workflowJob(workflow, "release");
		const releaseStep = (name) => jobStep(release, name);
		for (const name of TESTED_JOBS) {
			const job = workflowJob(workflow, name);
			for (const step of SHARED_SETUP) assert.equal(jobStep(job, step), releaseStep(step), `${name}: ${step} drifted`);
			const order = jobSteps(job).map((step) => step.name).filter((step) => SHARED_SETUP.includes(step));
			assert.deepEqual(order, SHARED_SETUP, `${name} runs the shared setup out of order`);
		}
		const preflight = workflowJob(workflow, "preflight");
		for (const step of PREFLIGHT_SETUP) assert.equal(jobStep(preflight, step), releaseStep(step), `preflight: ${step} drifted`);
	});

	// Release-train ruling on senpi#6642: with force_tests the release takes its base only from preflight's base_sha
	// output, even when the dispatch named a sha; without force_tests the dispatched sha passes through as before.
	it("passes release.mjs preflight's base_sha as --sha under force_tests, and the dispatched sha otherwise", () => {
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
						TESTED_SHA: "b".repeat(40),
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
				assert.deepEqual(forced.slice(forced.indexOf("--shard-results"), forced.indexOf("--shard-results") + 2), ["--shard-results", "/results"]);
			}
			assert.deepEqual(shaArgs(argsFor({ forceTests: false, releaseSha: "a".repeat(40) })), ["a".repeat(40)]);
			const plain = argsFor({ forceTests: false, releaseSha: "" });
			assert.deepEqual(shaArgs(plain), []);
			assert.equal(plain.includes("--shard-results"), false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	// Release-train ruling and review finding 1 on senpi#6645: a branch dispatch runs that branch's YAML with the push
	// token and id-token: write. Even with the sha input set to a main commit, no step that can stamp, tag, push or
	// publish may run unless the ref is main or the run is a dry run. Evaluates every such step's real `if:`.
	it("never reaches a step that can stamp, tag, push or publish from a branch ref unless dry_run, even with sha = a main commit", () => {
		const release = workflowJob(workflow, "release");
		const stepIf = (text) => text.match(/\n {8}if: (.*)\n/)?.[1] ?? "success()";
		const mutating = jobSteps(release).filter((step) => /npm run release|scripts\/publish\.mjs/.test(step.text));
		assert.deepEqual(mutating.map((step) => step.name), ["Run release", "Publish prepared version"]);
		const refusal = jobStep(release, "Refuse a live release from any ref but main");
		const branch = "refs/heads/ci/6642-forced-suite-matrix";
		for (const ref of ["refs/heads/main", branch]) {
			for (const dryRun of [false, true]) {
				for (const publishOnly of [false, true]) {
					for (const sha of ["", "a48cbcbfbe2ec209cc299ba23a9f32a562fbb444"]) {
						const context = {
							github: { ref, sha: "77ab284f3b36f62f0ca3d5c058d6c241d30b6ddf" },
							inputs: { dry_run: dryRun, "publish-only": publishOnly, force_tests: true, sha, version: "2026.11.13" },
						};
						// A publish-only dispatch checks out the TAG, whose own publish.mjs predates the in-code ref guard, so on a
						// branch even a dry run is refused before the job reaches npm (review of abfe92a6b5, finding 1).
						const refused = ref === branch && (!dryRun || publishOnly);
						const live = ref === branch && !dryRun;
						const label = `${ref} dry_run=${dryRun} publish-only=${publishOnly} sha=${sha || "(empty)"}`;
						assert.equal(isTruthy(evaluateExpression(stepIf(refusal), context)), refused, `refusal step, ${label}`);
						for (const step of mutating) {
							const runs = isTruthy(evaluateExpression(stepIf(step.text), context));
							if (live) assert.equal(runs, false, `${step.name} reachable on ${label}`);
						}
						if (!live) {
							assert.equal(isTruthy(evaluateExpression(stepIf(mutating[0].text), context)), !publishOnly, `Run release, ${label}`);
							assert.equal(isTruthy(evaluateExpression(stepIf(mutating[1].text), context)), publishOnly, `Publish, ${label}`);
						}
					}
				}
			}
		}
		assert.ok(release.indexOf("- name: Refuse a live release from any ref but main") < release.indexOf("- name: Checkout"));
		assert.match(refusal, /exit 1/);
	});

	// senpi#6645 review (32e83a5610, finding 1): a dry run on another ref may reach Run release, so the push token must
	// not: GH_TOKEN evaluates empty off main and the script never writes a credential into origin's URL there.
	it("gives Run release no push token and no credentialed origin on any ref but main", () => {
		const step = jobStep(workflowJob(workflow, "release"), "Run release");
		const tokenExpression = step.match(/\n {10}GH_TOKEN: \$\{\{ (.*) \}\}\n/)?.[1];
		assert.ok(tokenExpression, "expected GH_TOKEN as an expression");
		const token = (ref) => evaluateExpression(tokenExpression, { github: { ref }, secrets: { UPSTREAM_AUTOMATION_TOKEN: "PAT" } });
		assert.equal(token("refs/heads/main"), "PAT");
		for (const ref of ["refs/heads/ci/6642-forced-suite-matrix", "refs/tags/v2026.11.13"]) assert.equal(isTruthy(token(ref)), false, ref);
		// The preflight's `!= ''` presence check is the only other mention, and it yields a boolean, never the token.
		assert.equal((workflow.match(/secrets\.UPSTREAM_AUTOMATION_TOKEN(?! != '')/g) ?? []).length, 1, "the push token appears anywhere else");

		const script = step.match(/run: \|\n([\s\S]*)/)?.[1].replace(/^ {10}/gm, "");
		assert.ok(script);
		const root = mkdtempSync(join(tmpdir(), "run-release-token-"));
		try {
			const bin = join(root, "bin");
			mkdirSync(bin);
			const log = join(root, "calls.jsonl");
			for (const name of ["npm", "git"]) {
				writeFileSync(join(bin, name), `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify([${JSON.stringify(name)}, ...process.argv.slice(2)]) + "\\n");\n`);
				chmodSync(join(bin, name), 0o755);
			}
			const run = (ref, ghToken) => {
				rmSync(log, { force: true });
				const rendered = script.replaceAll("${{ inputs.force_tests }}", "false").replaceAll("${{ inputs.dry_run }}", "true");
				const result = spawnSync("bash", ["-c", rendered], {
					cwd: root,
					env: { PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: ghToken, GITHUB_REF: ref, GITHUB_REPOSITORY: "o/r", RELEASE_SHA: "", RELEASE_VERSION: "" },
					encoding: "utf8",
				});
				let calls = [];
				try {
					calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
				} catch {}
				return { result, calls, setUrl: calls.some((args) => args[0] === "git" && args[1] === "remote" && args[2] === "set-url") };
			};
			const branch = run("refs/heads/ci/6642-forced-suite-matrix", token("refs/heads/ci/6642-forced-suite-matrix"));
			assert.equal(branch.result.status, 0, branch.result.stderr);
			assert.equal(branch.setUrl, false, "a branch dry run wrote a credential into origin");
			assert.ok(branch.calls.some((args) => args[0] === "npm" && args.includes("--dry-run")), JSON.stringify(branch.calls));
			const main = run("refs/heads/main", token("refs/heads/main"));
			assert.equal(main.result.status, 0, main.result.stderr);
			assert.equal(main.setUrl, true);
			const mainWithoutToken = run("refs/heads/main", "");
			assert.notEqual(mainWithoutToken.result.status, 0);
			assert.match(mainWithoutToken.result.stdout, /UPSTREAM_AUTOMATION_TOKEN is required/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	// Review finding 6 on senpi#6645: under force_tests the summary names the commit the matrix tested and the release
	// tags (preflight's base_sha); otherwise the dispatched sha input, else the run's commit.
	it("reports the tested commit in the workflow summary under force_tests", () => {
		const summary = jobStep(workflowJob(workflow, "release"), "Workflow summary");
		const expression = summary.match(/commit="\$\{\{ (.*) \}\}"/)?.[1];
		assert.ok(expression, "expected the summary's commit expression");
		const commit = (forceTests, testedSha, sha) =>
			evaluateExpression(expression, {
				inputs: { force_tests: forceTests, sha },
				needs: { preflight: { outputs: { base_sha: testedSha } } },
				github: { sha: "GITHUBSHA" },
			});
		assert.equal(commit(true, "TESTED", ""), "TESTED");
		assert.equal(commit(true, "TESTED", "PINNED"), "TESTED");
		assert.equal(commit(false, "", "PINNED"), "PINNED");
		assert.equal(commit(false, "", ""), "GITHUBSHA");
		assert.equal(commit(true, "", ""), "GITHUBSHA", "a failed preflight falls back to the run's commit");
	});
});
