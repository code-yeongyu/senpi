#!/usr/bin/env node
// The release's first-minute preflight: everything knowable at dispatch is refused before any install, build or test,
// all refusals at once (fail-fast, cost-ordered), and the base commit and version are fixed once for every later job
// (senpi#6642 release-train ruling). Release contract: what may start a release at all.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runPreflight, staleCatalogNotices } from "./release-preflight.mjs";

const SHA = "a".repeat(40);
const checkRun = (conclusion, status = "completed") => [{ name: "Check and test", status, conclusion, head_sha: SHA }];

/** A dispatch every check accepts; each case overrides only what it is about. */
const green = (overrides = {}) => ({
	sha: SHA,
	version: "2026.11.21-3",
	forceTests: false,
	headSha: () => assert.fail("a pinned dispatch must not read HEAD"),
	assertOnMain: () => {},
	nextVersion: () => assert.fail("an explicit version must not be computed"),
	tagExists: () => false,
	published: () => false,
	assertPublishSetKnown: () => {},
	platformBlockers: () => [],
	checkRuns: () => checkRun("success"),
	...overrides,
});

describe("runPreflight", () => {
	it("accepts a dispatch every check passes and fixes its base and version", () => {
		assert.deepEqual(runPreflight(green()), {
			baseSha: SHA,
			version: "2026.11.21-3",
			refusals: [],
			notes: [`test gate: ${SHA.slice(0, 12)} has a green "Check and test" run; it is the release's test evidence`],
		});
	});

	it("reports every refusal of one dispatch at once instead of stopping at the first", () => {
		const result = runPreflight(
			green({
				assertOnMain: () => {
					throw new Error("aaaaaaaaaaaa is not on main");
				},
				tagExists: () => true,
				published: () => true,
				assertPublishSetKnown: () => {
					throw new Error("unknown to the npm registry: @code-yeongyu/senpi-new");
				},
				platformBlockers: () => ["ci.yml: macOS combined failed"],
				checkRuns: () => checkRun("failure"),
			}),
		);
		assert.equal(result.refusals.length, 6, result.refusals.join("\n"));
		for (const pattern of [/not on main/, /tag v2026\.11\.21-3 already exists/, /already published/, /senpi-new/, /macOS combined/, /CI failed on a{12}/]) {
			assert.ok(result.refusals.some((refusal) => pattern.test(refusal)), `${pattern} missing`);
		}
	});

	it("leaves an unfinished or unreadable CI run to the release job's wait, and never reads CI under force_tests", () => {
		assert.deepEqual(runPreflight(green({ checkRuns: () => checkRun(null, "in_progress") })).refusals, []);
		const unreadable = runPreflight(green({ checkRuns: () => null }));
		assert.deepEqual(unreadable.refusals, []);
		assert.match(unreadable.notes.join("\n"), /the CI lookup for a{12} failed; the release job waits for it/);
		assert.deepEqual(runPreflight(green({ forceTests: true, checkRuns: () => assert.fail("read CI under force_tests") })).refusals, []);
	});

	it("refuses a malformed version without looking it up, and computes one when none is given", () => {
		const looked = [];
		const malformed = runPreflight(green({ version: "2026.11.21-rc1", tagExists: (tag) => looked.push(tag) > 0 }));
		assert.match(malformed.refusals.join("\n"), /invalid version/);
		assert.deepEqual(looked, []);
		const computed = runPreflight(green({ version: undefined, nextVersion: () => "2026.11.21-4" }));
		assert.equal(computed.version, "2026.11.21-4");
		assert.deepEqual(computed.refusals, []);
	});

	it("resolves the checked-out commit as the base when no sha is pinned", () => {
		const result = runPreflight(green({ sha: undefined, headSha: () => SHA, assertOnMain: () => assert.fail("checked an unpinned base") }));
		assert.equal(result.baseSha, SHA);
	});
});

describe("staleCatalogNotices (senpi#2287)", () => {
	const now = Date.parse("2026-11-21T12:00:00Z");
	it("warns only for a refresh PR past its own workflow's limit", () => {
		const notices = staleCatalogNotices(
			[
				{ branch: "automation/model-catalog-refresh", number: 1, createdAt: "2026-11-17T11:00:00Z" },
				{ branch: "automation/model-catalog-refresh", number: 2, createdAt: "2026-11-19T12:00:00Z" },
				{ branch: "automation/opengateway-catalog-refresh", number: 3, createdAt: "2026-11-10T12:00:00Z" },
				{ branch: "automation/opengateway-catalog-refresh", number: 4, createdAt: "2026-11-01T12:00:00Z" },
			],
			now,
		);
		assert.deepEqual(notices.map((notice) => notice.match(/#(\d+)/)?.[1]), ["1", "4"]);
		assert.match(notices[0], /waited 4 days \(limit 3\)/);
	});
});

const PREFLIGHT_CLI = fileURLToPath(new URL("./release-preflight.mjs", import.meta.url));

// Release-train ruling on senpi#6642: the base commit is resolved once, here, and printed as a full sha (a step output
// and a log line); every later job and release.mjs use that output and never resolve main again.
describe("release-preflight CLI", () => {
	function withRepo(run) {
		const root = mkdtempSync(join(tmpdir(), "release-preflight-"));
		const dir = join(root, "repo");
		mkdirSync(dir);
		const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
		const commit = (message) => {
			writeFileSync(join(dir, "README.md"), `${message}\n`);
			git(dir, "add", "-A");
			git(dir, "-c", "user.name=t", "-c", "user.email=t@e", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
			return git(dir, "rev-parse", "HEAD");
		};
		try {
			git(dir, "init", "-q", "-b", "main");
			const base = commit("base");
			const origin = join(root, "origin.git");
			git(root, "init", "-q", "--bare", "-b", "main", origin);
			git(dir, "remote", "add", "origin", origin);
			git(dir, "push", "-q", "origin", "main");
			return run({ root, dir, base, commit, git });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}

	function runCli({ root, dir, args }) {
		const bin = join(root, "bin");
		mkdirSync(bin, { recursive: true });
		// npm view knows every publish-set name and no version; gh reports no main runs and no check runs.
		writeFileSync(join(bin, "npm"), `#!${process.execPath}\nconst a = process.argv.slice(2);\nif (a[0] === "view" && !a[1].includes("@2")) process.stdout.write(JSON.stringify(a[1]) + "\\n");\nelse { process.stderr.write("npm error code E404\\n"); process.exit(1); }\n`);
		writeFileSync(join(bin, "gh"), `#!${process.execPath}\nconst p = String(process.argv[3]);\nprocess.stdout.write(process.argv[2] === "pr" ? "[]" : p.includes("/actions/workflows/") ? JSON.stringify({ workflow_runs: [] }) : JSON.stringify([{ check_runs: [] }]));\n`);
		for (const name of ["npm", "gh"]) chmodSync(join(bin, name), 0o755);
		const output = join(root, "github-output");
		writeFileSync(output, "");
		const result = spawnSync(process.execPath, [PREFLIGHT_CLI, "--version", "2026.11.13", "--github-output", output, ...args], {
			cwd: dir,
			env: {
				...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(npm_|GITHUB_ACTIONS$|GITHUB_REF$)/i.test(key))),
				PATH: `${bin}${delimiter}${process.env.PATH}`,
			},
			encoding: "utf8",
			timeout: 30_000,
		});
		const outputs = Object.fromEntries(
			readFileSync(output, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => line.split("=")),
		);
		return { result, outputs };
	}

	it("without --sha, outputs the checked-out commit as the full base and the fixed version", () =>
		withRepo(({ root, dir, base }) => {
			const { result, outputs } = runCli({ root, dir, args: [] });
			assert.equal(result.status, 0, result.stderr + result.stdout);
			assert.deepEqual(outputs, { base_sha: base, version: "2026.11.13" });
			assert.equal(result.stdout.match(/base commit for every later job: ([0-9a-f]+)/g)?.length, 1, result.stdout);
		}));

	it("with --sha, outputs that pinned main commit, not the checkout it started from", () =>
		withRepo(({ root, dir, commit, git }) => {
			const pinned = commit("pinned");
			commit("main moved");
			git(dir, "push", "-q", "origin", "main");
			const { result, outputs } = runCli({ root, dir, args: ["--sha", pinned] });
			assert.equal(result.status, 0, result.stderr + result.stdout);
			assert.equal(outputs.base_sha, pinned);
		}));

	it("fails a live dispatch on a refusal before writing any output, and only warns in a dry run", () =>
		withRepo(({ root, dir, commit }) => {
			const branchOnly = commit("not on main");
			const live = runCli({ root, dir, args: ["--sha", branchOnly] });
			assert.notEqual(live.result.status, 0);
			assert.match(live.result.stdout, /::error::.*is not on main/);
			assert.deepEqual(live.outputs, {});
			const dry = runCli({ root, dir, args: ["--sha", branchOnly, "--dry-run"] });
			assert.equal(dry.result.status, 0, dry.result.stderr);
			assert.match(dry.result.stdout, /::warning::.*is not on main/);
		}));
});
