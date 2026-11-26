import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { syncRemoteMainBeforePush } from "./release-git.mjs";
import { pinReleaseCommit, preparePinnedRelease, syncPinnedReleaseIntoMain } from "./release-pin.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const runIn = (cwd) => (bin, args) => {
	execFileSync(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
};
const captureIn = (cwd) => (bin, args) => execFileSync(bin, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const quiet = () => {};
const identity = (cwd) => {
	for (const [key, value] of [
		["user.name", "t"],
		["user.email", "t@example.com"],
		["commit.gpgsign", "false"],
		["tag.gpgsign", "false"],
	]) {
		git(cwd, "config", key, value);
	}
};

/** An origin whose main has `later` on top of `pinned`, and a fresh clone of main's tip (the release job's checkout). */
function repoWithMovedMain(write = (dir, step) => writeFileSync(join(dir, `${step}.txt`), `${step}\n`)) {
	const root = mkdtempSync(join(tmpdir(), "senpi-pin-"));
	const origin = join(root, "origin.git");
	const work = join(root, "work");
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
	execFileSync("git", ["clone", "-q", origin, work], { stdio: "ignore" });
	identity(work);
	write(work, "pinned");
	git(work, "add", ".");
	git(work, "commit", "-q", "-m", "pinned");
	const pinned = git(work, "rev-parse", "HEAD");
	write(work, "later");
	git(work, "add", ".");
	git(work, "commit", "-q", "-m", "later");
	git(work, "push", "-q", "origin", "HEAD:main");
	const later = git(work, "rev-parse", "HEAD");
	const job = join(root, "job");
	execFileSync("git", ["clone", "-q", origin, job], { stdio: "ignore" });
	identity(job);
	return { root, work, job, pinned, later };
}

describe("pinned release commit (senpi#3609)", () => {
	it("tags the requested commit even when main moved past it", () => {
		const { root, job, pinned, later } = repoWithMovedMain();
		try {
			pinReleaseCommit(pinned, false, runIn(job), quiet, quiet, captureIn(job));
			assert.equal(git(job, "rev-parse", "HEAD"), pinned);
			assert.equal(git(job, "branch", "--show-current"), "main");
			writeFileSync(join(job, "VERSION"), "2026.10.19-9\n");
			git(job, "add", "VERSION");
			git(job, "commit", "-q", "-m", "release: v2026.10.19-9");
			git(job, "tag", "v2026.10.19-9");
			syncRemoteMainBeforePush(false, runIn(job), quiet, quiet);
			assert.equal(git(job, "rev-parse", "v2026.10.19-9^"), pinned);
			assert.throws(() => git(job, "cat-file", "-e", "v2026.10.19-9:later.txt"));
			assert.equal(git(job, "merge-base", "--is-ancestor", later, "HEAD"), "");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses a commit that main does not contain", () => {
		const { root, job } = repoWithMovedMain();
		try {
			const stray = git(job, "commit-tree", "-m", "stray", git(job, "rev-parse", "HEAD^{tree}"));
			assert.throws(() => pinReleaseCommit(stray, false, runIn(job), quiet, quiet, captureIn(job)), /not on main/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses a commit main only reached through a merged side branch", () => {
		const { root, work } = repoWithMovedMain();
		try {
			git(work, "checkout", "-q", "-b", "feature", "HEAD~1");
			writeFileSync(join(work, "feature.txt"), "feature\n");
			git(work, "add", ".");
			git(work, "commit", "-q", "-m", "pr head");
			const prHead = git(work, "rev-parse", "HEAD");
			git(work, "checkout", "-q", "main");
			git(work, "merge", "-q", "--no-ff", "--no-edit", "feature");
			git(work, "push", "-q", "origin", "main");
			assert.throws(() => pinReleaseCommit(prHead, false, runIn(work), quiet, quiet, captureIn(work)), /not one of main's own commits/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses anything but a full 40-character commit sha", () => {
		const never = () => assert.fail("must not run git");
		for (const bad of ["de7038a0ed", "main", "HEAD~1", ""]) {
			assert.throws(() => pinReleaseCommit(bad, false, never, quiet, quiet, never), /40-character/);
		}
	});

	it("a dry run performs the read-only checks and previews only the checkout", () => {
		const { root, job, pinned } = repoWithMovedMain();
		try {
			const previews = [];
			const head = git(job, "rev-parse", "HEAD");
			pinReleaseCommit(pinned, true, runIn(job), quiet, (m) => previews.push(m), captureIn(job));
			assert.deepEqual(previews, [`git checkout -B main ${pinned}`]);
			assert.equal(git(job, "rev-parse", "HEAD"), head);
			const stray = git(job, "commit-tree", "-m", "stray", git(job, "rev-parse", "HEAD^{tree}"));
			assert.throws(() => pinReleaseCommit(stray, true, runIn(job), quiet, quiet, captureIn(job)), /not on main/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("preparePinnedRelease", () => {
	it("reinstalls and rebuilds when the pinned commit differs from the job's checkout, and not otherwise", () => {
		const { root, job, pinned, later } = repoWithMovedMain();
		try {
			const calls = [];
			const runCommand = (bin, args) => {
				if (bin === "git") runIn(job)(bin, args);
				calls.push([bin, ...args].join(" "));
			};
			const options = { dryRun: false, runCommand, capture: captureIn(job), build: () => calls.push("build"), driftPaths: ["pinned.txt"], log: quiet, dryRunLog: quiet };
			preparePinnedRelease({ ...options, sha: pinned });
			assert.deepEqual(calls.slice(-3), ["npm install --ignore-scripts --no-audit --no-fund", "build", "git checkout -- pinned.txt"]);
			calls.length = 0;
			git(job, "checkout", "-q", "-B", "main", later);
			preparePinnedRelease({ ...options, sha: later });
			assert.ok(!calls.some((c) => c.startsWith("npm") || c === "build"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("pinned release: main's CHANGELOG after the merge-back (senpi#3731 review)", () => {
	const changelog = (unreleased) =>
		`# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n${unreleased}\n## [2026.10.18] - 2026-10-18\n\n### Fixed\n\n- old fix\n`;
	const write = (dir, step) => {
		mkdirSync(join(dir, "pkg"), { recursive: true });
		writeFileSync(join(dir, "pkg/CHANGELOG.md"), changelog(step === "pinned" ? "- fix A\n" : "- fix A\n- fix B later\n"));
	};

	it("keeps entries merged after the pinned commit under [Unreleased], and only the pinned ones under the version", () => {
		const { root, job, pinned } = repoWithMovedMain(write);
		try {
			pinReleaseCommit(pinned, false, runIn(job), quiet, quiet, captureIn(job));
			// release.mjs: stamp, commit, tag, re-add [Unreleased], commit.
			const file = join(job, "pkg/CHANGELOG.md");
			writeFileSync(file, readFileSync(file, "utf8").replace("## [Unreleased]", "## [2026.10.19] - 2026-10-19"));
			git(job, "commit", "-q", "-am", "release: v2026.10.19");
			git(job, "tag", "v2026.10.19");
			writeFileSync(file, readFileSync(file, "utf8").replace("## [2026.10.19]", "## [Unreleased]\n\n### Fixed\n\n## [2026.10.19]"));
			git(job, "commit", "-q", "-am", "Add [Unreleased] section for next cycle");

			syncPinnedReleaseIntoMain({
				pinnedSha: pinned,
				version: "2026.10.19",
				changelogs: ["pkg/CHANGELOG.md"],
				dryRun: false,
				runCommand: runIn(job),
				capture: captureIn(job),
				readFile: (path) => readFileSync(join(job, path), "utf8"),
				writeFile: (path, text) => writeFileSync(join(job, path), text),
				log: quiet,
				dryRunLog: quiet,
			});

			const merged = readFileSync(file, "utf8");
			const unreleased = merged.slice(merged.indexOf("## [Unreleased]"), merged.indexOf("## [2026.10.19]"));
			const released = merged.slice(merged.indexOf("## [2026.10.19]"), merged.indexOf("## [2026.10.18]"));
			assert.match(unreleased, /- fix B later/);
			assert.doesNotMatch(unreleased, /- fix A/);
			assert.match(released, /- fix A/);
			assert.doesNotMatch(released, /fix B later/);
			assert.doesNotMatch(git(job, "show", "v2026.10.19:pkg/CHANGELOG.md"), /fix B later/);
			assert.equal(git(job, "merge-base", "--is-ancestor", "origin/main", "HEAD"), "");
			assert.equal(git(job, "status", "--porcelain"), "");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
