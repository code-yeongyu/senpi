#!/usr/bin/env node
// senpi#6642: `release.mjs --tested-sha` releases the commit the forced-suite matrix jobs tested. It skips the catalog
// regeneration and the in-job suite, and refuses before stamping unless HEAD is that commit, its lineage from --sha
// holds, and every matrix job's result file names it. Release contract, exercised through the real CLI with real git.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CHANGELOGS } from "./release-changelog.mjs";
import { FORCED_SUITE_PARTS, forcedSuiteResultFile, writeForcedSuiteResult } from "./release-forced-suite-results.mjs";
import { WORKSPACE_PACKAGES } from "./release-packages.mjs";

const RELEASE = fileURLToPath(new URL("./release.mjs", import.meta.url));
const VERSION = "2026.11.13";

function withReleaseRepo(run) {
	const root = mkdtempSync(join(tmpdir(), "tested-release-"));
	const origin = join(root, "origin.git");
	const repo = join(root, "repo");
	const bin = join(root, "bin");
	const calls = join(root, "calls.jsonl");
	const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
	const write = (file, text) => {
		mkdirSync(dirname(join(repo, file)), { recursive: true });
		writeFileSync(join(repo, file), text);
	};
	try {
		git(root, "init", "-q", "--bare", "-b", "main", origin);
		mkdirSync(repo);
		git(repo, "init", "-q", "-b", "main");
		for (const [key, value] of [["user.name", "t"], ["user.email", "t@example.com"], ["commit.gpgsign", "false"], ["tag.gpgsign", "false"]]) {
			git(repo, "config", key, value);
		}
		git(repo, "remote", "add", "origin", origin);
		write("package.json", JSON.stringify({ workspaces: ["packages/*"] }));
		for (const file of WORKSPACE_PACKAGES) write(file, JSON.stringify({ version: "2026.11.12" }));
		for (const file of CHANGELOGS) write(file, "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Fixture.\n");
		write("packages/ai/src/models.generated.ts", "old\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-q", "-m", "base");
		const base = git(repo, "rev-parse", "HEAD");
		git(repo, "push", "-q", "origin", "main");
		write("packages/ai/src/models.generated.ts", "new\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-q", "-m", `chore(ai): regenerate the model catalog for v${VERSION}`);
		const tested = git(repo, "rev-parse", "HEAD");
		const results = join(root, "results");
		mkdirSync(results);
		for (const part of FORCED_SUITE_PARTS) writeForcedSuiteResult(results, { testedSha: tested, part, exitCode: 0, files: 1, tests: 1 });

		mkdirSync(bin);
		for (const name of ["npm", "node", "bun", "gh"]) {
			const body = `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(calls)}, JSON.stringify([${JSON.stringify(name)}, ...process.argv.slice(2)]) + "\\n");\n${name === "gh" ? "process.exit(1);\n" : ""}`;
			writeFileSync(join(bin, name), `#!${process.execPath}\n${body}`);
			chmodSync(join(bin, name), 0o755);
		}
		const release = (args, extraEnv = {}) => {
			const result = spawnSync(process.execPath, [RELEASE, "--version", VERSION, ...args], {
				cwd: repo,
				// GITHUB_ACTIONS/GITHUB_REF are dropped: under CI they would trip the main-only lock (release-ref-guard.mjs).
				env: {
					...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(npm_|GITHUB_ACTIONS$|GITHUB_REF$)/i.test(key))),
					PATH: `${bin}${delimiter}${process.env.PATH}`,
					...extraEnv,
				},
				encoding: "utf8",
				timeout: 30_000,
			});
			let commands = [];
			try {
				commands = readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
			} catch {}
			return { ...result, commands };
		};
		const originRefs = () => git(origin, "for-each-ref", "--format=%(refname) %(objectname)");
		return run({ repo, origin, base, tested, results, git, release, originRefs });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

const ranRegeneration = (commands) => commands.some((args) => args.includes("generate-models"));
const ranSuite = (commands) => commands.some((args) => args.includes("test:scripts") || args.some((arg) => /^--shard=/.test(arg)));

describe("release.mjs --tested-sha (senpi#6642)", () => {
	it("tags on top of the tested catalog commit without regenerating the catalog or re-running the suite", () =>
		withReleaseRepo(({ origin, base, tested, results, git, release }) => {
			const run = release(["--sha", base, "--tested-sha", tested, "--shard-results", results]);
			assert.equal(run.status, 0, run.stderr + run.stdout);
			assert.equal(ranRegeneration(run.commands), false, JSON.stringify(run.commands));
			assert.equal(ranSuite(run.commands), false, JSON.stringify(run.commands));
			assert.equal(run.commands.some((args) => args[0] === "gh"), false, "a tested release does not wait for CI");
			const tagged = git(origin, "rev-parse", `v${VERSION}^{commit}`);
			assert.equal(git(origin, "rev-parse", `${tagged}^`), tested, "the release commit sits directly on the tested commit");
			execFileSync("git", ["merge-base", "--is-ancestor", tagged, "main"], { cwd: origin });
		}));

	it("accepts the dispatched commit itself as the tested commit (no catalog change)", () =>
		withReleaseRepo(({ repo, origin, base, results, git, release }) => {
			git(repo, "checkout", "-q", "-B", "main", base);
			for (const part of FORCED_SUITE_PARTS) writeForcedSuiteResult(results, { testedSha: base, part, exitCode: 0, files: 1, tests: 1 });
			const run = release(["--sha", base, "--tested-sha", base, "--shard-results", results]);
			assert.equal(run.status, 0, run.stderr + run.stdout);
			assert.equal(git(origin, "rev-parse", `v${VERSION}^{commit}^`), base);
		}));

	it("refuses when HEAD is not the tested commit, before stamping or pushing", () =>
		withReleaseRepo(({ repo, base, tested, results, git, release, originRefs }) => {
			const before = originRefs();
			git(repo, "checkout", "-q", "-B", "main", base);
			const run = release(["--sha", base, "--tested-sha", tested, "--shard-results", results]);
			assert.notEqual(run.status, 0);
			assert.match(run.stderr, /HEAD/);
			assert.equal(originRefs(), before);
			assert.equal(git(repo, "rev-parse", "HEAD"), base, "a refused release committed");
		}));

	it("refuses when a matrix job's result file is missing, before stamping or pushing", () =>
		withReleaseRepo(({ repo, base, tested, results, git, release, originRefs }) => {
			const before = originRefs();
			unlinkSync(join(results, forcedSuiteResultFile("coding-agent-5")));
			const run = release(["--sha", base, "--tested-sha", tested, "--shard-results", results]);
			assert.notEqual(run.status, 0);
			assert.match(run.stderr, /coding-agent-5/);
			assert.equal(originRefs(), before);
			assert.equal(git(repo, "rev-parse", "HEAD"), tested, "a refused release committed");
		}));

	it("refuses a tested commit whose parent is not --sha, before stamping or pushing", () =>
		withReleaseRepo(({ repo, base, tested, results, git, release, originRefs }) => {
			git(repo, "checkout", "-q", "-B", "next", base);
			git(repo, "commit", "-q", "--allow-empty", "-m", "main moved on");
			const next = git(repo, "rev-parse", "HEAD");
			git(repo, "push", "-q", "origin", "next:main");
			git(repo, "checkout", "-q", "-B", "main", tested);
			const before = originRefs();
			const run = release(["--sha", next, "--tested-sha", tested, "--shard-results", results]);
			assert.notEqual(run.status, 0);
			assert.match(run.stderr, /parent/);
			assert.equal(originRefs(), before);
			assert.equal(git(repo, "rev-parse", "HEAD"), tested, "a refused release committed");
		}));

	// Review of senpi#6645, finding 2: the guard that stops a branch dispatch on the --tested-sha path is that --sha must
	// be on origin/main, whatever the local branch is called.
	it("refuses --tested-sha when --sha is a branch commit origin/main does not reach, even on a branch named main", () =>
		withReleaseRepo(({ repo, base, results, git, release, originRefs }) => {
			git(repo, "checkout", "-q", "-B", "main", base);
			writeFileSync(join(repo, "README.md"), "branch work\n");
			git(repo, "add", "-A");
			git(repo, "commit", "-q", "-m", "feature commit");
			const feature = git(repo, "rev-parse", "HEAD");
			for (const part of FORCED_SUITE_PARTS) writeForcedSuiteResult(results, { testedSha: feature, part, exitCode: 0, files: 1, tests: 1 });
			const before = originRefs();
			const run = release(["--sha", feature, "--tested-sha", feature, "--shard-results", results]);
			assert.notEqual(run.status, 0);
			assert.match(run.stderr, /is not on main/);
			assert.equal(originRefs(), before);
			assert.equal(git(repo, "rev-parse", "HEAD"), feature, "a refused release committed");
		}));

	it("needs --sha and --shard-results with --tested-sha, and refuses --force-tests with it", () =>
		withReleaseRepo(({ base, tested, results, release }) => {
			assert.match(release(["--tested-sha", tested, "--shard-results", results]).stderr, /--sha/);
			assert.match(release(["--sha", base, "--tested-sha", tested]).stderr, /--shard-results/);
			assert.match(release(["--sha", base, "--tested-sha", tested, "--shard-results", results, "--force-tests"]).stderr, /--force-tests/);
		}));
});

// Release-train ruling on senpi#6645: the release's preflight never trusts the local branch name. `git checkout -B main`
// on any commit used to satisfy it; now HEAD must be reachable from the fetched origin/main, or be the single
// catalog-only child of a commit that is. Release contract (what may be stamped, tagged and pushed).
describe("release.mjs preflight requires HEAD on origin/main, not a branch named main (senpi#6645)", () => {
	const refused = (run) => {
		assert.notEqual(run.status, 0, run.stdout);
		assert.match(run.stderr, /not reachable from origin\/main/);
	};

	it("refuses a local branch named main whose HEAD origin/main does not reach, in a dry run", () =>
		withReleaseRepo(({ repo, base, git, release, originRefs }) => {
			git(repo, "checkout", "-q", "-B", "main", base);
			writeFileSync(join(repo, "README.md"), "unreviewed\n");
			git(repo, "add", "-A");
			git(repo, "commit", "-q", "-m", "not on main");
			assert.equal(git(repo, "branch", "--show-current"), "main");
			const before = originRefs();
			refused(release(["--dry-run"]));
			assert.equal(originRefs(), before);
		}));

	it("refuses it in a live release too, before the catalog, the suite, any commit or any push", () =>
		withReleaseRepo(({ repo, base, git, release, originRefs }) => {
			git(repo, "checkout", "-q", "-B", "main", base);
			writeFileSync(join(repo, "README.md"), "unreviewed\n");
			git(repo, "add", "-A");
			git(repo, "commit", "-q", "-m", "not on main");
			const head = git(repo, "rev-parse", "HEAD");
			const before = originRefs();
			const run = release(["--force-tests"]);
			refused(run);
			assert.equal(run.commands.some((args) => args.includes("generate-models")), false, JSON.stringify(run.commands));
			assert.equal(git(repo, "rev-parse", "HEAD"), head, "a refused release committed");
			assert.equal(originRefs(), before);
		}));

	it("refuses a second catalog commit on top of the catalog-only child", () =>
		withReleaseRepo(({ repo, git, release }) => {
			writeFileSync(join(repo, "packages/ai/src/models.generated.ts"), "newer\n");
			git(repo, "add", "-A");
			git(repo, "commit", "-q", "-m", "catalog again");
			refused(release(["--dry-run"]));
		}));

	it("accepts HEAD equal to origin/main and the single catalog-only child of it", () =>
		withReleaseRepo(({ repo, base, git, release }) => {
			const child = release(["--dry-run"]);
			assert.equal(child.status, 0, child.stderr + child.stdout);
			assert.match(child.stdout, /would have prepared/);
			git(repo, "checkout", "-q", "-B", "main", base);
			const onMain = release(["--dry-run"]);
			assert.equal(onMain.status, 0, onMain.stderr + onMain.stdout);
		}));
});

// senpi#6645 review (32e83a5610, finding 1): inside GitHub Actions a live release refuses any ref but main in code, a
// lock independent of the workflow's step conditions; a dry run there, and any local run, still work.
describe("release.mjs refuses a live run in GitHub Actions off refs/heads/main (senpi#6645)", () => {
	it("refuses before pinning, stamping, committing or pushing, even for a main commit", () =>
		withReleaseRepo(({ repo, base, tested, results, git, release, originRefs }) => {
			const before = originRefs();
			const run = release(["--sha", base, "--tested-sha", tested, "--shard-results", results], {
				GITHUB_ACTIONS: "true",
				GITHUB_REF: "refs/heads/ci/6642-forced-suite-matrix",
			});
			assert.notEqual(run.status, 0);
			assert.match(run.stderr, /only from refs\/heads\/main/);
			assert.deepEqual(run.commands, [], "the refused release ran a command");
			assert.equal(originRefs(), before);
			assert.equal(git(repo, "rev-parse", "HEAD"), tested);
		}));

	it("still runs a dry run there, and a live run on refs/heads/main", () =>
		withReleaseRepo(({ base, tested, results, release }) => {
			const branch = { GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/ci/6642-forced-suite-matrix" };
			const dry = release(["--dry-run", "--sha", base, "--tested-sha", tested, "--shard-results", results], branch);
			assert.equal(dry.status, 0, dry.stderr + dry.stdout);
			const live = release(["--sha", base, "--tested-sha", tested, "--shard-results", results], { GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main" });
			assert.equal(live.status, 0, live.stderr + live.stdout);
		}));
});
