#!/usr/bin/env node
// senpi#6642: a release whose suite ran in the forced-suite matrix jobs must tag the commit those jobs tested, and that
// commit may differ from the dispatched one only by the release-only model catalog commit. Release contract.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { assertTestedLineage } from "./release-tested-lineage.mjs";

function withRepo(run) {
	const dir = mkdtempSync(join(tmpdir(), "tested-lineage-"));
	const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
	const write = (file, text) => {
		mkdirSync(dirname(join(dir, file)), { recursive: true });
		writeFileSync(join(dir, file), text);
	};
	const commit = (message, files) => {
		for (const [file, text] of Object.entries(files)) write(file, text);
		git("add", "-A");
		git("commit", "-q", "--allow-empty", "-m", message);
		return git("rev-parse", "HEAD");
	};
	try {
		git("init", "-q", "-b", "main");
		git("config", "user.name", "t");
		git("config", "user.email", "t@example.com");
		git("config", "commit.gpgsign", "false");
		const base = commit("base", { "README.md": "base\n", "packages/ai/src/models.generated.ts": "old\n" });
		return run({ dir, git, commit, base, capture: (bin, args) => execFileSync(bin, args, { cwd: dir, encoding: "utf8" }) });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("assertTestedLineage (senpi#6642 MUST 1, MUST 2)", () => {
	it("accepts the dispatched commit itself: the regeneration changed nothing", () =>
		withRepo(({ base, capture }) => {
			assert.equal(assertTestedLineage({ base, tested: base, capture }), "unchanged");
		}));

	it("accepts one child of the dispatched commit that touches only the regenerated catalog paths", () =>
		withRepo(({ base, commit, capture }) => {
			const tested = commit("catalog", {
				"packages/ai/src/models.generated.ts": "new\n",
				"packages/ai/src/providers/data/nvidia.json": "{}\n",
			});
			assert.equal(assertTestedLineage({ base, tested, capture }), "catalog");
		}));

	it("refuses a commit that is not a child of the dispatched commit", () =>
		withRepo(({ base, commit, capture }) => {
			commit("catalog 1", { "packages/ai/src/models.generated.ts": "one\n" });
			const grandchild = commit("catalog 2", { "packages/ai/src/models.generated.ts": "two\n" });
			assert.throws(() => assertTestedLineage({ base, tested: grandchild, capture }), /parent/);
		}));

	it("refuses an unrelated commit (a different history)", () =>
		withRepo(({ base, git, commit, capture }) => {
			git("checkout", "-q", "--orphan", "other");
			const unrelated = commit("unrelated", { "packages/ai/src/models.generated.ts": "x\n" });
			assert.throws(() => assertTestedLineage({ base, tested: unrelated, capture }), /parent/);
		}));

	it("refuses a child of the dispatched commit that touches a path outside the catalog", () =>
		withRepo(({ base, commit, capture }) => {
			const tested = commit("sneaky", {
				"packages/ai/src/models.generated.ts": "new\n",
				"packages/ai/src/stream.ts": "export {};\n",
			});
			assert.throws(() => assertTestedLineage({ base, tested, capture }), /packages\/ai\/src\/stream\.ts/);
		}));

	it("refuses a path that only shares a prefix with a catalog path", () =>
		withRepo(({ base, commit, capture }) => {
			const tested = commit("prefix", { "packages/ai/src/providers-extra.ts": "x\n" });
			assert.throws(() => assertTestedLineage({ base, tested, capture }), /providers-extra\.ts/);
		}));

	it("refuses a merge commit even when its first parent is the dispatched commit", () =>
		withRepo(({ base, git, commit, capture }) => {
			git("checkout", "-q", "-b", "side");
			commit("side", { "packages/ai/src/providers/data/a.json": "{}\n" });
			git("checkout", "-q", "main");
			git("merge", "-q", "--no-ff", "-m", "merge", "side");
			const merge = git("rev-parse", "HEAD");
			assert.throws(() => assertTestedLineage({ base, tested: merge, capture }), /2 parents/);
		}));

	it("refuses a child commit that changes nothing", () =>
		withRepo(({ base, commit, capture }) => {
			const empty = commit("empty", {});
			assert.throws(() => assertTestedLineage({ base, tested: empty, capture }), /changes nothing/);
		}));

	it("refuses an abbreviated or malformed tested sha", () =>
		withRepo(({ base, capture }) => {
			assert.throws(() => assertTestedLineage({ base, tested: base.slice(0, 12), capture }), /40-character/);
		}));
});
