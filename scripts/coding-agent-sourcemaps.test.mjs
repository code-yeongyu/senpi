#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";

it("packs runtime declarations and documentation without distribution sourcemaps", () => {
	// Given: the production files policy applied to a minimal, isolated package.
	const { files } = JSON.parse(readFileSync(new URL("../packages/coding-agent/package.json", import.meta.url), "utf8"));
	const root = mkdtempSync(join(tmpdir(), "senpi-sourcemap-pack-"));
	try {
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "senpi-pack-fixture", version: "1.0.0", files }));
		const retained = ["dist/index.js", "dist/index.d.ts", "dist/nested/types.d.ts", "docs/images/example.png", "docs/guide.md", "examples/example.ts", "CHANGELOG.md", "dist/core/export-html/vendor/example.js"];
		for (const path of [...retained, "dist/index.js.map", "dist/index.d.ts.map", "dist/nested/types.d.ts.map"]) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), "fixture");
		}

		// When: npm computes the real tarball file list.
		const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
			cwd: root, encoding: "utf8", timeout: 30000, shell: process.platform === "win32",
		});

		// Then: declarations and shipped assets survive while all fixture maps are omitted.
		assert.equal(result.status, 0, result.stderr);
		const [packed] = JSON.parse(result.stdout);
		const paths = packed.files.map((file) => file.path);
		assert.deepEqual(paths.filter((path) => path.endsWith(".map")), []);
		for (const path of retained) assert.ok(paths.includes(path), path);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
