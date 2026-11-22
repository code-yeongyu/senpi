#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { WORKSPACE_PACKAGES } from "./release-packages.mjs";
import { CHANGELOGS } from "./release-changelog.mjs";

// "superseded" is what CI reports when a newer push cancels the run: the always() fan-in fails, and its workflow run
// concludes cancelled.
const ciCheckRuns = (ci, head) =>
	JSON.stringify([
		{
			check_runs: [
				{
					id: 1,
					name: "Check and test",
					status: "completed",
					conclusion: ci === "superseded" ? "failure" : ci,
					head_sha: head,
					check_suite: { id: 7 },
				},
			],
		},
	]);

for (const { mergeStatus, ci, forceTests = false, platformRed = false, ciBasisReceipt = false, dryRun = false } of [
	{ mergeStatus: 0, ci: "success" },
	{ mergeStatus: 1, ci: "success" },
	{ mergeStatus: 0, ci: "failure" },
	{ mergeStatus: 0, ci: "superseded" },
	{ mergeStatus: 0, ci: "success", forceTests: true },
	// senpi#6834: a red macOS/Windows leg on main stops the release on the CI-evidence path and on one that runs its own suite.
	{ mergeStatus: 0, ci: "success", platformRed: true },
	{ mergeStatus: 0, ci: "success", forceTests: true, platformRed: true },
	// senpi#6859: an accepted CI-basis receipt for the pinned commit waives the hosted CI wait: an unfinished (here superseded)
	// run is read once and not waited for, but a known-red run still stops the release (review LOW L2 on senpi#6861).
	{ mergeStatus: 0, ci: "superseded", ciBasisReceipt: true },
	{ mergeStatus: 0, ci: "failure", ciBasisReceipt: true },
	// Review LOW L1 on senpi#6867: the dry run previews the refusal the live run makes on a red run, never "no CI wait".
	{ mergeStatus: 0, ci: "failure", ciBasisReceipt: true, dryRun: true },
]) {
	it(`release CLI with CI ${ci}${forceTests ? " and --force-tests" : ""}${platformRed ? " and a red main platform run" : ""}${ciBasisReceipt ? " and a CI-basis receipt" : ""}${dryRun ? " in a dry run" : ""} recovers concurrent main advancement and respects merge exit ${mergeStatus}`, () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-release-cli-"));
		// A pinned --sha must be 40 hex; every other case keeps the readable fixture name.
		const head = ciBasisReceipt ? "f".repeat(40) : "fixture-sha";
		try {
			// The forced suite resolves the root "workspaces" and shards coding-agent's own `test` script (senpi#6139).
			writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
			for (const file of WORKSPACE_PACKAGES) {
				mkdirSync(dirname(join(root, file)), { recursive: true });
				const scripts = file === "packages/coding-agent/package.json" ? { scripts: { test: "vitest --run" } } : {};
				writeFileSync(join(root, file), JSON.stringify({ version: "2026.9.12-2", ...scripts }));
			}
			for (const file of CHANGELOGS) {
				writeFileSync(join(root, file), "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Fixture.\n");
			}
			const bin = join(root, "bin");
			mkdirSync(bin);
			const calls = join(root, "commands.jsonl");
			for (const name of ["git", "npm", "node", "bun", "gh"]) {
				const body = `
import { appendFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify([${JSON.stringify(name)}, ...args]) + "\\n");
if (${JSON.stringify(name)} === "git") {
	if (args[0] === "branch") process.stdout.write("main\\n");
	if (args[0] === "rev-parse" && args[1] === "origin/main") { process.stdout.write("fixture-main\\n"); process.exit(0); }
	if (args[0] === "rev-parse") process.stdout.write("${head}\\n");
	// A pinned release's commit is one of main's own first-parent commits (release-pin.mjs).
	if (args[0] === "rev-list") process.stdout.write("${head}\\n");
	// The fixture's HEAD is a main commit: preflight's reachability check from origin/main passes (senpi#6645).
	if (args[0] === "merge-base" && args[2] === "${head}" && args[3] === "origin/main") process.exit(0);
	if (args[0] === "merge-base") process.exit(1);
	if (args[0] === "merge") process.exit(${mergeStatus});
}
// The registry preflight (senpi#6636): every publish-set name is known here.
if (${JSON.stringify(name)} === "npm" && args[0] === "view") process.stdout.write(JSON.stringify(args[1]) + "\\n");
if (${JSON.stringify(name)} === "npm" && args[0] === "run" && args[1] === "test:scripts") {
	const changelog = require("node:fs").readFileSync(${JSON.stringify(join(root, CHANGELOGS[0]))}, "utf8");
	writeFileSync(${JSON.stringify(join(root, "TEST_SAW_CHANGELOG"))}, changelog.includes("## [Unreleased]\\n\\n### Fixed\\n\\n- Fixture.") ? "unstamped" : "stamped");
}
if (${JSON.stringify(name)} === "gh" && String(args[1]).includes("/actions/workflows/")) {
	const file = String(args[1]).split("/actions/workflows/")[1].split("/")[0];
	process.stdout.write(JSON.stringify({ workflow_runs: [{ id: 99, conclusion: ${platformRed} && file === "ci.yml" ? "failure" : "success", html_url: "https://example.test/runs/99", head_sha: "fixture-main" }] }));
	process.exit(0);
}
if (${JSON.stringify(name)} === "gh" && String(args[1]).includes("/actions/runs/99/jobs")) {
	process.stdout.write(JSON.stringify([{ jobs: [{ name: "macOS combined", labels: ["macos-latest"], conclusion: "failure" }, { name: "Static checks", labels: ["ubuntu-latest"], conclusion: "success" }] }]));
	process.exit(0);
}
if (${JSON.stringify(name)} === "gh") {
	process.stdout.write(String(args[1]).includes("actions/runs?check_suite_id=7")
		? ${JSON.stringify(JSON.stringify({ workflow_runs: [{ status: "completed", conclusion: ci === "superseded" ? "cancelled" : "failure" }] }))}
		: ${JSON.stringify(ciCheckRuns(ci, head))});
}
`;
				const runner = join(bin, `${name}.mjs`);
				writeFileSync(runner, body);
				if (process.platform === "win32") {
					writeFileSync(join(bin, `${name}.cmd`), `@"${process.execPath}" "${runner}" %*\r\n`);
				} else {
					writeFileSync(join(bin, name), `#!${process.execPath}\n${body}`);
					chmodSync(join(bin, name), 0o755);
				}
			}
			const result = spawnSync(process.execPath, [fileURLToPath(new URL("./release.mjs", import.meta.url)), "--version", "2026.9.12-3", ...(forceTests ? ["--force-tests"] : []), ...(ciBasisReceipt ? ["--sha", head, "--ci-basis-receipt", "rcpt-1"] : []), ...(dryRun ? ["--dry-run"] : [])], {
				cwd: root,
				// Without npm_* (set when this runs under `npm run`), run-workspaces resolves the stubbed npm from PATH.
				env: {
					// GITHUB_ACTIONS/GITHUB_REF are dropped: under CI they would trip the main-only lock (release-ref-guard.mjs).
					...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(npm_|GITHUB_ACTIONS$|GITHUB_REF$)/i.test(key))),
					PATH: `${bin}${delimiter}${dirname(process.execPath)}`,
				},
				encoding: "utf8",
				// A hang guard, not a speed budget: every case spawns a dozen stub processes, and on a loaded host (load 65 on
				// 14 cores, senpi#6834 follow-up) 15 s killed releases that were still making progress.
				timeout: 60_000,
			});
			const commands = readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse);
			// The forced suite's steps: `npm run test:scripts`, then the coding-agent shards through run-workspaces.
			const isScriptsStep = (args) => args[0] === "npm" && args[1] === "run" && args[2] === "test:scripts";
			const isShard = (n) => (args) => JSON.stringify(args) === JSON.stringify(["npm", "run", "test", "--", `--shard=${n}/2`]);
			const isForcedSuiteStep = (args) => isScriptsStep(args) || isShard(1)(args) || isShard(2)(args);
			if (platformRed) {
				assert.equal(result.status, 1, result.stderr);
				assert.match(result.stderr, /ci\.yml.*macOS combined.*example\.test\/runs\/99/);
				assert.deepEqual(commands.filter((args) => args[1] === "push" || args[1] === "tag"), []);
				assert.equal(commands.some((args) => args[1] === "commit" && /^release: v/.test(args.at(-1))), false);
				return;
			}
			if (forceTests) {
				// The forced suite tests the release's code before the version and changelog stamping: a test that reads a
				// real CHANGELOG.md must see its [Unreleased] section, as CI would (v2026.10.16 release run 38824836070).
				assert.equal(result.status, 0, result.stderr);
				const index = (predicate) => commands.findIndex(predicate);
				const test = index(isScriptsStep);
				const shards = [index(isShard(1)), index(isShard(2))];
				const firstClean = index((args) => args[0] === "npm" && args[1] === "run" && args[2] === "clean");
				const firstBuild = index((args) => args[0] === "npm" && args[1] === "run" && args[2] === "build");
				const releaseCommit = index((args) => args[1] === "commit" && /^release: v/.test(args.at(-1)));
				assert.ok(firstClean >= 0 && firstClean < firstBuild && firstBuild < test && test < releaseCommit, JSON.stringify(commands));
				assert.ok(shards.every((shard) => shard > test && shard < releaseCommit), JSON.stringify(commands));
				assert.equal(readFileSync(join(root, "TEST_SAW_CHANGELOG"), "utf8"), "unstamped");
				assert.equal(commands.some((args) => args[0] === "gh" && String(args[2]).includes("check-runs")), false, "a forced release does not wait for CI");
				return;
			}
			if (ciBasisReceipt) {
				const checkRunReads = commands.filter((args) => args[0] === "gh" && String(args[2]).includes("check-runs"));
				assert.equal(checkRunReads.length, 1, "the waived release reads CI once and never polls it");
				assert.equal(commands.some(isForcedSuiteStep), false);
				if (dryRun) {
					assert.equal(result.status, 0, result.stderr);
					assert.match(result.stdout, /\[dry-run\] the live run would refuse: CI failed on f{12}.*a ci_basis_receipt waives only the wait/);
					assert.doesNotMatch(result.stdout, /no CI wait/);
					assert.deepEqual(commands.filter((args) => args[1] === "push" || args[1] === "tag"), []);
					return;
				}
				if (ci === "failure") {
					assert.equal(result.status, 1, result.stderr);
					assert.match(result.stderr, /CI failed on f{12}.*a ci_basis_receipt waives only the wait/);
					assert.deepEqual(commands.filter((args) => args[1] === "push" || args[1] === "tag" || args[1] === "commit"), []);
					return;
				}
				assert.equal(result.status, 0, result.stderr);
				// Review LOW L2 on senpi#6867: the one read classified the run as superseded, not as a missing run.
				assert.match(result.stdout, /test gate: the CI run for f{12} was cancelled/);
				assert.match(result.stdout, new RegExp(`hosted CI wait waived by ci_basis_receipt rcpt-1 for the pinned commit ${head}`));
				return;
			}
			if (ci === "superseded") {
				// The workflow run's outcome is read, so the cancellation is recognised (not "CI failed"), and since
				// main moved to a tip that does not contain the commit, the release stops before tagging (senpi#2943).
				assert.equal(result.status, 1, result.stderr);
				assert.ok(commands.some((args) => args[0] === "gh" && String(args[2]).includes("actions/runs?check_suite_id=7")), JSON.stringify(commands));
				assert.match(result.stderr, /main moved to fixture-main, which does not contain fixture-sha/);
				assert.deepEqual(commands.filter((args) => args[1] === "push" || args[1] === "tag"), []);
				return;
			}
			if (ci !== "success") {
				// senpi#2943: red CI on the release commit stops the release before it commits, tags or pushes.
				assert.equal(result.status, 1, result.stderr);
				assert.match(result.stderr, /CI failed on fixture-sha/);
				assert.deepEqual(commands.filter((args) => args[1] === "push" || args[1] === "tag" || args[1] === "commit"), []);
				assert.equal(commands.some(isForcedSuiteStep), false);
				return;
			}
			assert.equal(commands.some(isForcedSuiteStep), false);
			// senpi#2287: the release ships the catalog main committed and CI tested; it never regenerates or re-checks it.
			assert.equal(commands.some((args) => args.includes("generate-models") || args.includes("check:provider-defaults")), false, JSON.stringify(commands));
			assert.ok(commands.some((args) => args[0] === "git" && args[1] === "merge"), result.stderr);
			assert.equal(result.status, mergeStatus, result.stderr);
			assert.deepEqual(commands.filter((args) => args[1] === "push"), mergeStatus === 0 ? [
				["git", "push", "origin", "main"],
				["git", "push", "origin", "v2026.9.12-3"],
			] : []);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}
