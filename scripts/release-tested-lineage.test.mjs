#!/usr/bin/env node
// senpi#6642: a release whose suite ran in the forced-suite matrix jobs must tag the commit those jobs tested, and that
// commit may differ from the dispatched one only by the release-only model catalog commit. Release contract.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { GENERATED_HEADER, isRegeneratedCatalogPath } from "./release-test-gate.mjs";
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

	// Review of senpi#6645, finding 3: the catalog allow-list is what generate-models.ts writes, never the whole
	// providers directory, which also holds hand-written provider runtime code.
	it("refuses a catalog child that also touches a hand-written provider runtime file", () =>
		withRepo(({ base, commit, capture }) => {
			const tested = commit("catalog plus runtime", {
				"packages/ai/src/providers/data/nvidia.json": "{}\n",
				"packages/ai/src/providers/anthropic.ts": "export {};\n",
			});
			assert.throws(() => assertTestedLineage({ base, tested, capture }), /packages\/ai\/src\/providers\/anthropic\.ts/);
		}));

	it("accepts a child that regenerates, adds and prunes generator-written .models.ts shards", () =>
		withRepo(({ git, commit, capture }) => {
			commit("shards", { "packages/ai/src/providers/old.models.ts": `${GENERATED_HEADER}\nold\n` });
			const parent = git("rev-parse", "HEAD");
			git("rm", "-q", "packages/ai/src/providers/old.models.ts");
			const tested = commit("regenerate", { "packages/ai/src/providers/new.models.ts": `${GENERATED_HEADER}\nnew\n` });
			assert.equal(assertTestedLineage({ base: parent, tested, capture }), "catalog");
		}));

	// The generator leaves fork-owned shards alone (FORK_OWNED_MODEL_SHARDS in packages/ai/scripts/model-shards.ts):
	// they carry no generator header, so a change to one is hand-written code, not catalog.
	it("refuses a catalog child that edits a hand-written, fork-owned .models.ts shard", () =>
		withRepo(({ git, commit, capture }) => {
			commit("fork shard", { "packages/ai/src/providers/kimi-coding.models.ts": "/** Kimi, owned by the fork. */\nexport {};\n" });
			const parent = git("rev-parse", "HEAD");
			const tested = commit("edit it", {
				"packages/ai/src/providers/kimi-coding.models.ts": "/** Kimi, owned by the fork. */\nexport const X = 1;\n",
				"packages/ai/src/providers/data/kimi.json": "{}\n",
			});
			assert.throws(() => assertTestedLineage({ base: parent, tested, capture }), /kimi-coding\.models\.ts/);
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

describe("isRegeneratedCatalogPath matches what generate-models.ts writes (senpi#6645 review, finding 3)", () => {
	it("covers every tracked generator output in packages/ai/src and nothing hand-written", () => {
		const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
		const tracked = execFileSync("git", ["ls-files", "--", "packages/ai/src"], { cwd: repoRoot, encoding: "utf8" })
			.split("\n")
			.filter(Boolean);
		// The generator's own marker: every TypeScript file it writes starts with this header; its JSON goes to data/.
		const generated = (path) =>
			path.startsWith("packages/ai/src/providers/data/") ||
			(path.endsWith(".ts") && readFileSync(join(repoRoot, path), "utf8").startsWith(GENERATED_HEADER));
		const content = (path) => readFileSync(join(repoRoot, path), "utf8");
		const mismatched = tracked.filter((path) => isRegeneratedCatalogPath(path, content(path)) !== generated(path));
		assert.deepEqual(mismatched, []);
		assert.ok(tracked.filter(generated).length > 40, "expected the generated catalog in the tree");
		assert.equal(isRegeneratedCatalogPath("packages/ai/src/providers/anthropic.ts", content("packages/ai/src/providers/anthropic.ts")), false);
		assert.equal(isRegeneratedCatalogPath("packages/ai/src/providers/kimi-coding.models.ts", content("packages/ai/src/providers/kimi-coding.models.ts")), false);
		assert.equal(isRegeneratedCatalogPath("packages/ai/src/providers/openai.models.ts", content("packages/ai/src/providers/openai.models.ts")), true);
	});
});
