#!/usr/bin/env node
// senpi#6642: the forced-suite prepare job regenerates the model catalog once, commits a changed catalog on the release
// only, and hands that exact commit to every matrix job as a git bundle. Release contract (MUST 2 no-change path).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { formatPrepareOutputs, prepareTestedCommit, TESTED_COMMIT_REF } from "./release-forced-prepare.mjs";

const MANIFEST = "packages/ai/src/providers/data/.manifest.json";
const manifest = (generatedAt) => `${JSON.stringify({ schemaVersion: 6, generatedAt, files: { "a.json": "h1" } })}\n`;

function withRepo(run) {
	const root = mkdtempSync(join(tmpdir(), "forced-prepare-"));
	const dir = join(root, "repo");
	mkdirSync(dir);
	const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
	const write = (file, text) => {
		mkdirSync(dirname(join(dir, file)), { recursive: true });
		writeFileSync(join(dir, file), text);
	};
	try {
		git(dir, "init", "-q", "-b", "main");
		git(dir, "config", "user.name", "t");
		git(dir, "config", "user.email", "t@example.com");
		git(dir, "config", "commit.gpgsign", "false");
		write("packages/ai/src/models.generated.ts", "old\n");
		write(MANIFEST, manifest("2026-11-01T00:00:00.000Z"));
		git(dir, "add", "-A");
		git(dir, "commit", "-q", "-m", "base");
		const base = git(dir, "rev-parse", "HEAD");
		return run({ root, dir, base, git, write, bundlePath: join(root, "tested-commit.bundle") });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("prepareTestedCommit (senpi#6642)", () => {
	it("hands over the dispatched commit itself, and no bundle, when the regeneration changes nothing (MUST 2)", () =>
		withRepo(({ dir, base, git, bundlePath }) => {
			const result = prepareTestedCommit({ cwd: dir, version: "2026.11.13", regenerate: () => {}, bundlePath, log: () => {} });
			assert.equal(result.baseSha, base);
			assert.equal(result.testedSha, base);
			assert.equal(result.testedTree, git(dir, "rev-parse", "HEAD^{tree}"));
			assert.equal(result.bundle, false);
			assert.equal(existsSync(bundlePath), false, "a no-change prepare wrote a bundle");
			assert.equal(git(dir, "rev-parse", "HEAD"), base, "a no-change prepare committed");
			assert.match(formatPrepareOutputs(result, "2026.11.13"), new RegExp(`^tested_sha=${base}$`, "m"));
			assert.match(formatPrepareOutputs(result, "2026.11.13"), /^bundle=false$/m);
		}));

	it("treats a regeneration that only re-stamped the manifest as no change", () =>
		withRepo(({ dir, base, write, bundlePath }) => {
			const result = prepareTestedCommit({
				cwd: dir,
				version: "2026.11.13",
				regenerate: () => write(MANIFEST, manifest("2026-11-13T00:00:00.000Z")),
				bundlePath,
				log: () => {},
			});
			assert.equal(result.testedSha, base);
			assert.equal(result.bundle, false);
		}));

	it("commits a changed catalog as one child of the dispatched commit and bundles it for a shallow checkout", () =>
		withRepo(({ root, dir, base, git, write, bundlePath }) => {
			const result = prepareTestedCommit({
				cwd: dir,
				version: "2026.11.13",
				regenerate: () => write("packages/ai/src/models.generated.ts", "new\n"),
				bundlePath,
				log: () => {},
			});
			assert.equal(result.baseSha, base);
			assert.notEqual(result.testedSha, base);
			assert.equal(result.bundle, true);
			assert.equal(git(dir, "rev-list", "--parents", "-n", "1", result.testedSha), `${result.testedSha} ${base}`);
			assert.equal(git(dir, "log", "-1", "--format=%s", result.testedSha), "chore(ai): regenerate the model catalog for v2026.11.13");
			assert.equal(git(dir, "diff", "--name-only", base, result.testedSha), "packages/ai/src/models.generated.ts");
			// A matrix job checks out the dispatched commit shallowly, then fetches the tested commit from the bundle.
			const clone = join(root, "clone");
			git(root, "clone", "-q", "--depth", "1", `file://${dir}`, clone);
			git(clone, "fetch", "-q", "--no-tags", bundlePath, TESTED_COMMIT_REF);
			assert.equal(git(clone, "rev-parse", "FETCH_HEAD"), result.testedSha);
			assert.match(formatPrepareOutputs(result, "2026.11.13"), /^bundle=true$/m);
			assert.match(formatPrepareOutputs(result, "2026.11.13"), /^version=2026\.11\.13$/m);
			assert.match(formatPrepareOutputs(result, "2026.11.13"), new RegExp(`^base_sha=${base}$`, "m"));
		}));
});
