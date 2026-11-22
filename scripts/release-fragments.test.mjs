#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { CHANGELOGS, reAddUnreleasedSections, stampChangelogs } from "./release-changelog.mjs";
import { pinReleaseCommit, syncPinnedReleaseIntoMain } from "./release-pin.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const COMPILE = join(ROOT, "scripts/sync-changes-fragments.mjs");
const LOG = "packages/ai/CHANGELOG.md";
const quiet = () => {};
const fragment = (bullet) => `<!-- changes-log: ${LOG} -->\n### Fixed\n- ${bullet}\n`;
const LATER = fragment(
	"later fragment describes an unrelated improvement with distinct details so Git does not mistake it for a rename of the consumed fragment",
);

// Release ownership contract: a standalone workflow must not consume fragments on main before the cut.
// Exercise any configured standalone compiler against the same pinned/main history as the release.
it("a pinned release lists its fragment once and leaves later fragments for the next cut (senpi#3767)", () => {
	const root = mkdtempSync(join(tmpdir(), "senpi-release-fragments-"));
	const origin = join(root, "origin.git");
	const work = join(root, "work");
	const run = (bin, args) =>
		execFileSync(bin, args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
	const git = (...args) => run("git", args).trim();
	const write = (path, text) => {
		mkdirSync(dirname(join(work, path)), { recursive: true });
		writeFileSync(join(work, path), text);
	};
	const commit = (message) => {
		git("add", "-A");
		git("commit", "-q", "-m", message);
	};
	const originalCwd = process.cwd();
	try {
		execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { timeout: 30_000 });
		execFileSync("git", ["clone", "-q", origin, work], { stdio: "ignore", timeout: 30_000 });
		for (const [key, value] of [
			["user.name", "T"],
			["user.email", "t@example.com"],
			["commit.gpgsign", "false"],
			["tag.gpgsign", "false"],
		]) {
			git("config", key, value);
		}
		for (const path of CHANGELOGS) {
			write(
				path,
				"# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n## [2026.10.18] - 2026-10-18\n\n### Fixed\n\n- old fix\n",
			);
		}
		write("changes/unreleased/21.md", fragment("shipped fragment"));
		commit("pinned with fragment");
		const pinned = git("rev-parse", "HEAD");

		// Run the real compiler if a workflow can still compile independently of release.mjs.
		const workflows = join(ROOT, ".github/workflows");
		for (const name of readdirSync(workflows).filter((name) => /\.ya?ml$/.test(name))) {
			const text = readFileSync(join(workflows, name), "utf8");
			if (/^\s*(?:node|bun) scripts\/sync-changes-fragments\.mjs compile\s*$/m.test(text)) {
				run(process.execPath, [COMPILE, "compile"]);
			}
		}
		write("changes/unreleased/22.md", LATER);
		commit("main advances after pin");
		git("push", "-q", "origin", "main");
		pinReleaseCommit(pinned, false, run, quiet, quiet, run);

		// The prepare cut compiles, stamps, commits and tags, then restores [Unreleased].
		run(process.execPath, [COMPILE, "compile"]);
		process.chdir(work);
		const captured = new Map();
		stampChangelogs("2026.10.19", "2026-10-19", false, captured, quiet, quiet);
		commit("release: v2026.10.19");
		git("tag", "v2026.10.19");
		reAddUnreleasedSections("2026.10.19", "2026-10-19", false, captured, quiet, quiet);
		commit("next cycle");
		syncPinnedReleaseIntoMain({
			pinnedSha: pinned,
			version: "2026.10.19",
			changelogs: CHANGELOGS,
			dryRun: false,
			runCommand: run,
			capture: run,
			readFile: (path) => readFileSync(join(work, path), "utf8"),
			writeFile: write,
			log: quiet,
			dryRunLog: quiet,
		});

		const merged = readFileSync(join(work, LOG), "utf8");
		const unreleased = merged.split("## [2026.10.19]")[0];
		assert.doesNotMatch(unreleased, /shipped fragment/, "shipped fragment must not remain in [Unreleased]");
		assert.equal(merged.match(/- shipped fragment/g)?.length, 1);
		assert.doesNotMatch(git("show", `v2026.10.19:${LOG}`), /later fragment/);
		assert.equal(existsSync(join(work, "changes/unreleased/21.md")), false);
		assert.equal(readFileSync(join(work, "changes/unreleased/22.md"), "utf8"), LATER);
		assert.equal(git("status", "--porcelain"), "");

		run(process.execPath, [COMPILE, "compile"]);
		stampChangelogs("2026.10.20", "2026-10-20", false, new Map(), quiet, quiet);
		const next = readFileSync(join(work, LOG), "utf8");
		assert.match(next.split("## [2026.10.19]")[0], /later fragment/);
		assert.doesNotMatch(next.split("## [2026.10.19]")[0], /shipped fragment/);
		assert.equal(next.match(/- shipped fragment/g)?.length, 1);
	} finally {
		process.chdir(originalCwd);
		rmSync(root, { recursive: true, force: true });
	}
});
