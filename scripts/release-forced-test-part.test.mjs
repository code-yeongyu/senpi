#!/usr/bin/env node
// senpi#6642: one forced-suite matrix job runs one part of the suite (the rest job, or coding-agent shard i of N) on
// the tested commit and writes the result file release.mjs --tested-sha counts. Release contract (MUST 3, MUST 4).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { countTestSummary, selectForcedTestPart } from "./release-forced-test-part.mjs";
import { FORCED_SHARD_JOBS, planForcedTestSuite } from "./release-forced-test-suite.mjs";
import { forcedSuiteResultFile } from "./release-forced-suite-results.mjs";
import { resolveWorkspaceDirectories } from "./run-workspaces.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const PART_CLI = fileURLToPath(new URL("./release-forced-test-part.mjs", import.meta.url));
const workspaceOf = (step) => step.args[step.args.indexOf("--workspace") + 1];

describe("selectForcedTestPart (senpi#6642 MUST 4)", () => {
	// The expectation is derived, never a hand-written list (release-train ruling on senpi#6642): what run-workspaces
	// resolves from the root `workspaces` field today, minus coding-agent, so a new workspace can never be silently
	// dropped from forced cuts. Workspaces without a `test` script are skipped, as `npm test` (`--if-present`) skips them.
	it("runs test:scripts and every tested workspace run-workspaces resolves, minus coding-agent, in the rest job", async () => {
		const workspaces = await resolveWorkspaceDirectories(repoRoot);
		const expectedRest = (resolved) => [
			"scripts",
			...resolved
				.filter((workspace) => typeof workspace.scripts.test === "string")
				.map((workspace) => workspace.relativePath)
				.filter((path) => path !== "packages/coding-agent"),
		];
		const restLabels = (resolved) =>
			selectForcedTestPart(
				planForcedTestSuite({ rootDirectory: repoRoot, workspaces: resolved, shards: FORCED_SHARD_JOBS }),
				"rest",
			).serial.map((step) => step.label);
		const expected = expectedRest(workspaces);
		assert.ok(expected.length > 2, `run-workspaces resolved too few tested workspaces: ${expected.join(", ")}`);
		assert.deepEqual(restLabels(workspaces), expected);
		assert.deepEqual(selectForcedTestPart(planForcedTestSuite({ rootDirectory: repoRoot, workspaces, shards: 2 }), "rest").parallel, []);
		// Negative control: a rest plan missing any one tested workspace fails the same comparison.
		for (const dropped of expected.slice(1)) {
			const rest = restLabels(workspaces).filter((label) => label !== dropped);
			assert.throws(() => assert.deepEqual(rest, expected), undefined, `dropping ${dropped} stayed green`);
		}
	});

	it("runs exactly coding-agent shard i of N in shard job i", async () => {
		const plan = planForcedTestSuite({
			rootDirectory: repoRoot,
			workspaces: await resolveWorkspaceDirectories(repoRoot),
			shards: FORCED_SHARD_JOBS,
		});
		for (let shard = 1; shard <= FORCED_SHARD_JOBS; shard++) {
			const part = selectForcedTestPart(plan, String(shard));
			assert.deepEqual(part.serial, []);
			assert.equal(part.parallel.length, 1);
			assert.equal(workspaceOf(part.parallel[0]), "packages/coding-agent");
			assert.deepEqual(part.parallel[0].args.slice(-2), ["--", `--shard=${shard}/${FORCED_SHARD_JOBS}`]);
		}
		assert.throws(() => selectForcedTestPart(plan, "0"), /part/);
		assert.throws(() => selectForcedTestPart(plan, String(FORCED_SHARD_JOBS + 1)), /part/);
	});
});

describe("countTestSummary", () => {
	it("adds vitest and node:test summary lines, ignoring colour codes", () => {
		const counts = { files: 0, tests: 0 };
		for (const line of [
			" \u001b[2mTest Files \u001b[22m \u001b[1m\u001b[32m12 passed\u001b[39m\u001b[22m\u001b[90m (12)\u001b[39m",
			"      Tests  340 passed | 2 skipped (342)",
			"ℹ tests 50",
			"# tests 7",
			"unrelated line with Tests in it",
		]) {
			countTestSummary(line, counts);
		}
		assert.deepEqual(counts, { files: 12, tests: 342 + 50 + 7 });
	});
});

function withFixture(run) {
	const root = mkdtempSync(join(tmpdir(), "forced-part-"));
	const write = (file, text) => {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), text);
	};
	const vitestSummary = (code) =>
		`console.log(" Test Files  2 passed (2)"); console.log("      Tests  5 passed (5)"); process.exit(${code});`;
	try {
		write("package.json", JSON.stringify({ workspaces: ["packages/*"], scripts: { "test:scripts": "node print.cjs" } }));
		write("print.cjs", 'console.log("ℹ tests 4");');
		write("packages/ai/package.json", JSON.stringify({ name: "ai", scripts: { test: "node t.cjs" } }));
		write("packages/ai/t.cjs", vitestSummary(0));
		write("packages/coding-agent/package.json", JSON.stringify({ name: "ca", scripts: { test: "node t.cjs" } }));
		write("packages/coding-agent/t.cjs", `${vitestSummary("process.argv.includes('--shard=3/6') ? 0 : 9")}`);
		const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
		git("init", "-q", "-b", "main");
		git("-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "add", "-A");
		git("-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture");
		const head = git("rev-parse", "HEAD");
		const out = join(root, "results");
		const runPart = (part, testedSha) =>
			spawnSync(process.execPath, [PART_CLI, "--part", part, "--tested-sha", testedSha, "--out-dir", out], {
				cwd: root,
				env: {
					...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key))),
					PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
				},
				encoding: "utf8",
				timeout: 60_000,
			});
		const result = (id) => JSON.parse(readFileSync(join(out, forcedSuiteResultFile(id)), "utf8"));
		return run({ head, out, runPart, result });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("release-forced-test-part CLI (senpi#6642 MUST 3)", () => {
	it("runs the rest part and records the tested commit, exit 0 and the file and test counts", () =>
		withFixture(({ head, runPart, result }) => {
			const run = runPart("rest", head);
			assert.equal(run.status, 0, run.stderr + run.stdout);
			assert.deepEqual(result("rest"), { tested_sha: head, part: "rest", shard: null, of: null, exit: 0, files: 2, tests: 9 });
		}));

	it("runs coding-agent shard i of N and records it under that shard", () =>
		withFixture(({ head, runPart, result }) => {
			const run = runPart("3", head);
			assert.equal(run.status, 0, run.stderr + run.stdout);
			assert.deepEqual(result("coding-agent-3"), {
				tested_sha: head,
				part: "coding-agent",
				shard: 3,
				of: FORCED_SHARD_JOBS,
				exit: 0,
				files: 2,
				tests: 5,
			});
		}));

	it("records a failing shard as failed and exits non-zero", () =>
		withFixture(({ head, runPart, result }) => {
			const run = runPart("2", head);
			assert.notEqual(run.status, 0);
			assert.equal(result("coding-agent-2").exit, 1);
		}));

	it("refuses to run on any commit but the tested one, and writes no result", () =>
		withFixture(({ out, runPart }) => {
			const run = runPart("rest", "c".repeat(40));
			assert.notEqual(run.status, 0);
			assert.match(run.stderr, /cccccccccccc/);
			assert.equal(existsSync(join(out, forcedSuiteResultFile("rest"))), false);
		}));
});
