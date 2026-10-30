// The scratch copy EQ mutations run in (plan P0-05d): a mutation is applied, run and reverted in a copy of the committed
// tree, never in the working tree, and the copy keeps the source's ignored dependencies with their relative links.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyPatch, entriesToCopy, makeScratch, porcelain, revertPatch } from "./equivalence-mutation-scratch.mjs";

const git = (cwd, ...args) => {
	const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
		cwd,
		encoding: "utf8",
	});
	assert.equal(r.status, 0, r.stderr);
	return r.stdout;
};

function withRepo(body) {
	const root = mkdtempSync(join(tmpdir(), "eq-mutations-scratch-"));
	const source = join(root, "source");
	try {
		mkdirSync(join(source, "packages", "pkg"), { recursive: true });
		writeFileSync(join(source, ".gitignore"), "node_modules\nlocal-ignore/\n");
		writeFileSync(join(source, "packages", "pkg", "index.js"), "export const value = 1;\n");
		git(source, "init", "--quiet");
		git(source, "add", ".");
		git(source, "commit", "--quiet", "-m", "base");
		mkdirSync(join(source, "node_modules"));
		symlinkSync("../packages/pkg", join(source, "node_modules", "pkg"));
		mkdirSync(join(source, "local-ignore", "qa-evidence"), { recursive: true });
		writeFileSync(join(source, "local-ignore", "qa-evidence", "big.json"), "{}\n");
		const patch = join(root, "mutation.patch");
		writeFileSync(
			patch,
			[
				"diff --git a/packages/pkg/index.js b/packages/pkg/index.js",
				"--- a/packages/pkg/index.js",
				"+++ b/packages/pkg/index.js",
				"@@ -1 +1 @@",
				"-export const value = 1;",
				"+export const value = 2;",
				"",
			].join("\n"),
		);
		return body({ root, source, patch });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("the scratch is a clean copy at HEAD whose dependency links resolve inside the copy", () =>
	withRepo(({ root, source }) => {
		const scratch = makeScratch(source, root);
		try {
			assert.equal(scratch.head, git(source, "rev-parse", "HEAD").trim());
			assert.equal(porcelain(scratch.dir), "");
			assert.equal(readlinkSync(join(scratch.dir, "node_modules", "pkg")), "../packages/pkg");
			assert.equal(
				readFileSync(join(scratch.dir, "node_modules", "pkg", "index.js"), "utf8"),
				"export const value = 1;\n",
			);
			assert.equal(existsSync(join(scratch.dir, "local-ignore")), false);
		} finally {
			scratch.remove();
		}
		assert.equal(existsSync(scratch.root), false);
	}));

test("a mutation applied and reverted in the scratch leaves it clean and never touches the source", () =>
	withRepo(({ root, source, patch }) => {
		const scratch = makeScratch(source, root);
		try {
			const applied = applyPatch(scratch.dir, patch);
			assert.deepEqual(applied, { applied: true, files: ["packages/pkg/index.js"] });
			assert.equal(
				readFileSync(join(scratch.dir, "node_modules", "pkg", "index.js"), "utf8"),
				"export const value = 2;\n",
			);
			assert.equal(readFileSync(join(source, "packages", "pkg", "index.js"), "utf8"), "export const value = 1;\n");
			assert.deepEqual(revertPatch(scratch.dir, patch), { clean: true, reapplies: true });
			assert.equal(porcelain(source), "");
		} finally {
			scratch.remove();
		}
	}));

test("a dirty source is refused and a patch that no longer applies is reported, not forced", () =>
	withRepo(({ root, source, patch }) => {
		writeFileSync(join(source, "packages", "pkg", "index.js"), "export const value = 3;\n");
		assert.throws(() => makeScratch(source, root), /not clean; commit first/);
		git(source, "commit", "--quiet", "-am", "moved on");
		const scratch = makeScratch(source, root);
		try {
			assert.deepEqual(applyPatch(scratch.dir, patch), { applied: false, files: [] });
			assert.equal(porcelain(scratch.dir), "");
		} finally {
			scratch.remove();
		}
	}));

test("run output and build caches are not copied into the scratch", () => {
	assert.deepEqual(
		entriesToCopy([
			"node_modules/",
			"local-ignore/",
			"crates/x/target/",
			"a.log",
			"packages/ai/src/models.generated.ts",
			"",
		]),
		["node_modules/", "packages/ai/src/models.generated.ts"],
	);
});
