#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { it } from "node:test";
import { copyPublishTree } from "./copy-publish-tree.mjs";
import { stagePublishManifest } from "./prepare-senpi-publish-manifest.mjs";

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

it("removes maps from dependencies already installed beneath the publish package", () => {
	// Given: npm's unhoisted dependency layout, which does not pass through tree copying.
	const root = mkdtempSync(join(tmpdir(), "senpi-existing-publish-tree-"));
	try {
		const codingAgent = join(root, "packages/coding-agent");
		const dependency = join(codingAgent, "node_modules/unhoisted");
		mkdirSync(join(dependency, "node_modules/nested"), { recursive: true });
		writeFileSync(join(codingAgent, "package.json"), JSON.stringify({ name: "@code-yeongyu/senpi", version: "1.0.0", files: ["dist"], dependencies: { unhoisted: "1.0.0" } }));
		writeFileSync(join(dependency, "package.json"), JSON.stringify({ name: "unhoisted", version: "1.0.0" }));
		const retained = ["index.js", "index.d.ts"];
		const maps = ["index.js.map", "index.d.ts.map", "node_modules/nested/index.js.map"];
		for (const path of [...retained, ...maps]) writeFileSync(join(dependency, path), path);

		// When: the final manifest selects packages from the actual installed tree.
		stagePublishManifest(root);

		// Then: even packages that were not copied ship declarations without source maps.
		for (const path of retained) assert.equal(readFileSync(join(dependency, path), "utf8"), path);
		for (const path of maps) assert.equal(existsSync(join(dependency, path)), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
