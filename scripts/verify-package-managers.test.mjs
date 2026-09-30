#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { snapshotRepo } from "./verify-package-managers.mjs";

it("copies the source snapshot without external tools and preserves build exclusions", async () => {
	const dir = mkdtempSync(join(tmpdir(), "verify-pm-snapshot-"));
	const source = join(dir, "source");
	const destination = join(dir, "snapshot");
	const kept = ["package.json", "src/keep.ts", ".husky/pre-commit", "packages/coding-agent/src/cli.ts"];
	const excluded = [
		"node_modules/dependency/index.js",
		"nested/node_modules/dependency/index.js",
		".git/config",
		"dist/cli.js",
		"nested/dist/output.js",
		".worktrees/branch/source.ts",
		".husky/_/h",
		"packages/coding-agent/binaries/platform.exe",
		"local-ignore/private.json",
		".pi/auth.json",
		".opencode/auth.json",
		"nested/cache.log",
		"nested/cache.tsbuildinfo",
	];
	const contents = Buffer.from([0, 1, 127, 255]);
	const path = process.env.PATH;
	try {
		for (const relative of [...kept, ...excluded]) {
			const file = join(source, relative);
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, contents);
		}
		process.env.PATH = "";

		await snapshotRepo(destination, source);

		for (const relative of kept) assert.deepEqual(readFileSync(join(destination, relative)), contents);
		for (const relative of excluded) assert.equal(existsSync(join(destination, relative)), false, relative);
	} finally {
		if (path === undefined) delete process.env.PATH;
		else process.env.PATH = path;
		rmSync(dir, { recursive: true, force: true });
	}
});
