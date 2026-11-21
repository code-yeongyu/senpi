import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { pinReleaseCommit, syncPinnedReleaseIntoMain } from "./release-pin.mjs";

const CATALOG = "packages/ai/src/providers/data/openrouter.json";
const HAND_WRITTEN = "packages/ai/src/providers/openrouter.ts";
const VERSION = "2026.11.21";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const put = (dir, file, text) => {
	mkdirSync(dirname(join(dir, file)), { recursive: true });
	writeFileSync(join(dir, file), text);
};
const commitAll = (dir, message) => {
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", message);
};

/**
 * A pinned release whose own commit rewrites `file` (as the release's catalog regeneration does) while main has since
 * rewritten the same lines, so the merge-back conflicts there.
 */
function pinnedReleaseConflictingOn(file, releaseAlso = () => {}, pinnedAlso = () => {}) {
	const root = mkdtempSync(join(tmpdir(), "senpi-pin-catalog-"));
	const origin = join(root, "origin.git");
	const job = join(root, "job");
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
	execFileSync("git", ["clone", "-q", origin, job], { stdio: "ignore" });
	for (const [key, value] of [
		["user.name", "t"],
		["user.email", "t@example.com"],
		["commit.gpgsign", "false"],
		["tag.gpgsign", "false"],
	]) {
		git(job, "config", key, value);
	}
	put(job, file, "pinned\n");
	pinnedAlso(job);
	commitAll(job, "pinned");
	const pinned = git(job, "rev-parse", "HEAD");
	put(job, file, "main refresh\n");
	commitAll(job, "main refreshes it");
	git(job, "push", "-q", "origin", "HEAD:main");

	pinReleaseCommit(pinned, false, (bin, args) => execFileSync(bin, args, { cwd: job, stdio: "ignore" }), () => {}, () => {}, (bin, args) =>
		execFileSync(bin, args, { cwd: job, encoding: "utf8" }),
	);
	put(job, file, "release regeneration\n");
	releaseAlso(job);
	commitAll(job, `chore(ai): regenerate the model catalog for v${VERSION}`);
	git(job, "tag", `v${VERSION}`);
	return { root, job, pinned };
}

function mergeBack(job, pinned) {
	syncPinnedReleaseIntoMain({
		pinnedSha: pinned,
		version: VERSION,
		changelogs: [],
		dryRun: false,
		runCommand: (bin, args) => execFileSync(bin, args, { cwd: job, stdio: ["ignore", "pipe", "pipe"] }),
		capture: (bin, args) => execFileSync(bin, args, { cwd: job, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
		readFile: (path) => readFileSync(join(job, path), "utf8"),
		writeFile: (path, text) => writeFileSync(join(job, path), text),
		log: () => {},
		dryRunLog: () => {},
	});
}

describe("pinned release merge-back: generated catalog conflicts (senpi#6119)", () => {
	it("keeps main's catalog when the release's regenerated catalog conflicts with main's, and the tag keeps its own", () => {
		const { root, job, pinned } = pinnedReleaseConflictingOn(CATALOG);
		try {
			mergeBack(job, pinned);
			assert.equal(readFileSync(join(job, CATALOG), "utf8"), "main refresh\n");
			assert.equal(git(job, "show", `v${VERSION}:${CATALOG}`), "release regeneration");
			assert.equal(git(job, "merge-base", "--is-ancestor", "origin/main", "HEAD"), "");
			assert.equal(git(job, "status", "--porcelain"), "");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("restores main's whole catalog, so a file only the release changed or added cannot disagree with main's manifest", () => {
		const MANIFEST = "packages/ai/src/providers/data/.manifest.json";
		const ONLY_RELEASE = "packages/ai/src/providers/data/b.json";
		const ADDED = "packages/ai/src/providers/data/new.json";
		const { root, job, pinned } = pinnedReleaseConflictingOn(MANIFEST, (dir) => {
			put(dir, ONLY_RELEASE, "b-rel\n");
			put(dir, ADDED, "new\n");
		}, (dir) => put(dir, ONLY_RELEASE, "b0\n"));
		try {
			mergeBack(job, pinned);
			assert.equal(readFileSync(join(job, MANIFEST), "utf8"), "main refresh\n");
			assert.equal(readFileSync(join(job, ONLY_RELEASE), "utf8"), "b0\n");
			assert.equal(existsSync(join(job, ADDED)), false);
			assert.equal(git(job, "show", `v${VERSION}:${ONLY_RELEASE}`), "b-rel");
			assert.equal(git(job, "status", "--porcelain"), "");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("still fails the release on a conflict in a hand-written file", () => {
		const { root, job, pinned } = pinnedReleaseConflictingOn(HAND_WRITTEN);
		try {
			assert.throws(() => mergeBack(job, pinned), /conflicts outside the changelogs: packages\/ai\/src\/providers\/openrouter\.ts/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
