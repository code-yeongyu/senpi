#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { it } from "node:test";
import { copyPublishTree } from "./copy-publish-tree.mjs";

it("omits dependency and vendor sourcemaps when staging publish trees", () => {
	// Given: representative runtime, type, nested-dependency and vendor files.
	const root = mkdtempSync(join(tmpdir(), "senpi-publish-tree-"));
	try {
		const source = join(root, "source");
		const destination = join(root, "destination");
		const retained = ["dist/index.js", "dist/index.d.ts", "node_modules/nested/index.js", "vendor/types.d.ts", "assets/image.png"];
		const maps = ["dist/index.js.map", "dist/index.d.ts.map", "node_modules/nested/index.js.map", "vendor/types.d.ts.map"];
		for (const path of [...retained, ...maps, "test/excluded.js"]) {
			mkdirSync(dirname(join(source, path)), { recursive: true });
			writeFileSync(join(source, path), path);
		}

		// When: staging applies a workspace filter as well as the sourcemap policy.
		copyPublishTree(source, destination, { filter: (path) => relative(source, path) !== "test" });

		// Then: source maps stay in the build tree but never reach publish output.
		for (const path of retained) assert.equal(readFileSync(join(destination, path), "utf8"), path);
		for (const path of maps) {
			assert.equal(readFileSync(join(source, path), "utf8"), path);
			assert.equal(existsSync(join(destination, path)), false);
		}
		assert.equal(existsSync(join(destination, "test")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
