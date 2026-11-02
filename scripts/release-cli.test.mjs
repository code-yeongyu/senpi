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

const MANIFEST = "packages/ai/src/providers/data/.manifest.json";
const manifestText = (generatedAt) => `${JSON.stringify({ schemaVersion: 6, generatedAt, files: { "nvidia.json": "h1" } })}\n`;
// "superseded" is what CI reports when a newer push cancels the run: the always() fan-in fails, and its workflow run
// concludes cancelled.
const ciCheckRuns = (ci) =>
	JSON.stringify([
		{
			check_runs: [
				{
					id: 1,
					name: "Check and test",
					status: "completed",
					conclusion: ci === "superseded" ? "failure" : ci,
					head_sha: "fixture-sha",
					check_suite: { id: 7 },
				},
			],
		},
	]);

for (const { mergeStatus, ci, catalogDirty = false, manifestStampOnly = false, forceTests = false } of [
	{ mergeStatus: 0, ci: "success" },
	{ mergeStatus: 1, ci: "success" },
	{ mergeStatus: 0, ci: "failure" },
	{ mergeStatus: 0, ci: "success", catalogDirty: true },
	{ mergeStatus: 0, ci: "superseded" },
	{ mergeStatus: 0, ci: "success", manifestStampOnly: true },
	{ mergeStatus: 0, ci: "success", forceTests: true },
	{ mergeStatus: 0, ci: "success", catalogDirty: true, forceTests: true },
]) {
	it(`release CLI with CI ${ci}${catalogDirty ? " and a changed catalog" : ""}${forceTests ? " and --force-tests" : ""} recovers concurrent main advancement and respects merge exit ${mergeStatus}`, () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-release-cli-"));
		try {
			for (const file of WORKSPACE_PACKAGES) {
				mkdirSync(dirname(join(root, file)), { recursive: true });
				writeFileSync(join(root, file), JSON.stringify({ version: "2026.9.12-2" }));
			}
			for (const file of CHANGELOGS) {
				writeFileSync(join(root, file), "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Fixture.\n");
			}
			if (manifestStampOnly) {
				mkdirSync(dirname(join(root, MANIFEST)), { recursive: true });
				writeFileSync(join(root, MANIFEST), manifestText("2026-10-08T09:00:00.000Z"));
			}
			const bin = join(root, "bin");
			mkdirSync(bin);
			const calls = join(root, "commands.jsonl");
			for (const name of ["git", "npm", "node", "bun", "gh"]) {
				const body = `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify([${JSON.stringify(name)}, ...args]) + "\\n");
if (${JSON.stringify(name)} === "git") {
	if (args[0] === "branch") process.stdout.write("main\\n");
	if (args[0] === "status" && ${catalogDirty} && args.includes("packages/ai/src/providers")) {
		process.stdout.write(" M packages/ai/src/providers/data/nvidia.json\\n");
	}
	if (args[0] === "status" && ${manifestStampOnly} && args.includes("packages/ai/src/providers") && !existsSync(${JSON.stringify(join("RESTORED"))})) {
		process.stdout.write(" M ${MANIFEST}\\n");
	}
	if (args[0] === "show" && args[1] === "HEAD:${MANIFEST}") process.stdout.write(${JSON.stringify(manifestText("2026-10-01T00:00:00.000Z"))});
	if (args[0] === "checkout" && args[2] === "${MANIFEST}") writeFileSync("RESTORED", "");
	if (args[0] === "rev-parse" && args[1] === "origin/main") { process.stdout.write("fixture-main\\n"); process.exit(0); }
	if (args[0] === "rev-parse") process.stdout.write("fixture-sha\\n");
	if (args[0] === "merge-base") process.exit(1);
	if (args[0] === "merge") process.exit(${mergeStatus});
}
if (${JSON.stringify(name)} === "npm" && args[0] === "test") {
	const changelog = require("node:fs").readFileSync(${JSON.stringify(CHANGELOGS[0])}, "utf8");
	writeFileSync("TEST_SAW_CHANGELOG", changelog.includes("## [Unreleased]\\n\\n### Fixed\\n\\n- Fixture.") ? "unstamped" : "stamped");
}
if (${JSON.stringify(name)} === "gh") {
	process.stdout.write(String(args[1]).includes("actions/runs?check_suite_id=7")
		? ${JSON.stringify(JSON.stringify({ workflow_runs: [{ status: "completed", conclusion: ci === "superseded" ? "cancelled" : "failure" }] }))}
		: ${JSON.stringify(ciCheckRuns(ci))});
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
			const result = spawnSync(process.execPath, [fileURLToPath(new URL("./release.mjs", import.meta.url)), "--version", "2026.9.12-3", ...(forceTests ? ["--force-tests"] : [])], {
				cwd: root,
				env: { ...process.env, PATH: `${bin}${delimiter}${dirname(process.execPath)}` },
				encoding: "utf8",
				timeout: 15000,
			});
			const commands = readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse);
			if (catalogDirty && !forceTests) {
				// A changed catalog is never pushed to main untested (v2026.10.19-1): without --force-tests the release stops
				// before it commits, tags or pushes anything.
				assert.equal(result.status, 1, result.stderr);
				assert.match(result.stderr, /dispatch with force_tests/);
				assert.deepEqual(commands.filter((args) => args[1] === "push" || args[1] === "tag"), []);
				return;
			}
			if (catalogDirty && forceTests) {
				// The catalog commit stays on the release; the forced suite runs after it, and main is pushed once, at the end.
				assert.equal(result.status, 0, result.stderr);
				const index = (predicate) => commands.findIndex(predicate);
				const catalogCommit = index((args) => args[1] === "commit" && /regenerate the model catalog/.test(args.at(-1)));
				const test = index((args) => args[0] === "npm" && args[1] === "test");
				const firstPush = index((args) => args[1] === "push");
				assert.ok(catalogCommit >= 0 && catalogCommit < test && test < firstPush, JSON.stringify(commands));
				assert.deepEqual(commands.filter((args) => args[1] === "push"), [
					["git", "push", "origin", "main"],
					["git", "push", "origin", "v2026.9.12-3"],
				]);
				return;
			}
			if (forceTests) {
				// The forced suite tests the release's code before the version and changelog stamping: a test that reads a
				// real CHANGELOG.md must see its [Unreleased] section, as CI would (v2026.10.16 release run 38824836070).
				assert.equal(result.status, 0, result.stderr);
				const index = (predicate) => commands.findIndex(predicate);
				const test = index((args) => args[0] === "npm" && args[1] === "test");
				const firstClean = index((args) => args[0] === "npm" && args[1] === "run" && args[2] === "clean");
				const firstBuild = index((args) => args[0] === "npm" && args[1] === "run" && args[2] === "build");
				const releaseCommit = index((args) => args[1] === "commit" && /^release: v/.test(args.at(-1)));
				assert.ok(firstClean >= 0 && firstClean < firstBuild && firstBuild < test && test < releaseCommit, JSON.stringify(commands));
				assert.equal(readFileSync(join(root, "TEST_SAW_CHANGELOG"), "utf8"), "unstamped");
				assert.equal(commands.some((args) => args[0] === "gh"), false, "a forced release does not wait for CI");
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
			if (manifestStampOnly) {
				// A regeneration that only re-stamped the manifest restores it and pushes no catalog commit.
				assert.equal(result.status, 0, result.stderr);
				assert.ok(commands.some((args) => args[1] === "checkout" && args[3] === MANIFEST), JSON.stringify(commands));
				assert.equal(commands.some((args) => args[1] === "commit" && /regenerate the model catalog/.test(args.at(-1))), false);
				assert.deepEqual(commands.filter((args) => args[1] === "push"), [
					["git", "push", "origin", "main"],
					["git", "push", "origin", "v2026.9.12-3"],
				]);
				return;
			}
			if (ci !== "success") {
				// senpi#2943: red CI on the release commit stops the release before it commits, tags or pushes.
				assert.equal(result.status, 1, result.stderr);
				assert.match(result.stderr, /CI failed on fixture-sha/);
				assert.deepEqual(commands.filter((args) => args[1] === "push" || args[1] === "tag" || args[1] === "commit"), []);
				assert.equal(commands.some((args) => args[0] === "npm" && args[1] === "test"), false);
				return;
			}
			assert.equal(commands.some((args) => args[0] === "npm" && args[1] === "test"), false);
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
