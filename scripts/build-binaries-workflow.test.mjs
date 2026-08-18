#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { describe, it } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/build-binaries.yml", import.meta.url), "utf8");
const buildScriptUrl = new URL("./build-binaries.sh", import.meta.url);
const buildScript = readFileSync(buildScriptUrl, "utf8");
const resourceLoader = readFileSync(
	new URL("../packages/coding-agent/src/core/resource-loader.ts", import.meta.url),
	"utf8",
);
const codingAgentPackage = JSON.parse(
	readFileSync(new URL("../packages/coding-agent/package.json", import.meta.url), "utf8"),
);

describe("binary release workflow", () => {
	it("pins a stable Bun release with downloadable cross-compile executables", () => {
		assert.match(workflow, /bun-version:\s*['"]1\.3\.14['"]/);
		assert.doesNotMatch(workflow, /bun-version:\s*canary/);
		assert.doesNotMatch(workflow, /assert-bun-canary\.sh/);
	});

	it("keeps recovery source refs separate from the published release tag", () => {
		assert.match(workflow, /RELEASE_TAG:\s*\$\{\{ github\.event\.inputs\.tag \|\| github\.ref_name \}\}/);
		assert.match(
			workflow,
			/SOURCE_REF:\s*\$\{\{ github\.event\.inputs\.source_ref \|\| github\.event\.inputs\.tag \|\| github\.ref_name \}\}/,
		);
	});

	it("embeds jsdom's sync worker in release binaries", () => {
		if (process.platform !== "win32") {
			assert.notEqual(statSync(buildScriptUrl).mode & 0o111, 0);
		}
		assert.match(buildScript, /node scripts\/prepare-bun-compile-assets\.mjs/);
		assert.match(buildScript, /node_modules\/jsdom\/lib\/jsdom\/living\/xhr\/xhr-sync-worker\.js/);
		assert.match(buildScript, /smoke-standalone-binary\.mjs/);
	});

	it("keeps the package binary build aligned with release packaging", () => {
		const binaryBuild = codingAgentPackage.scripts["build:binary"];
		assert.match(binaryBuild, /npm --prefix \.\.\/pty run build/);
		assert.match(binaryBuild, /node \.\.\/\.\.\/scripts\/prepare-bun-compile-assets\.mjs/);
		assert.match(binaryBuild, /node_modules\/jsdom\/lib\/jsdom\/living\/xhr\/xhr-sync-worker\.js/);
		assert.doesNotMatch(binaryBuild, /--external=css-tree/);
	});

	it("ships and explicitly resolves the bundled codemode sidecar", () => {
		assert.match(buildScript, /copy-codemode-sidecar\.mjs"\s+"\$OUTPUT_DIR\/\$platform"/);
		assert.match(codingAgentPackage.scripts["copy-binary-assets"], /copy-codemode-sidecar\.mjs dist/);
		assert.match(
			resourceLoader,
			/node_modules["'`]\s*,\s*["'`]@code-yeongyu["'`]\s*,\s*["'`]senpi-codemode["'`]\s*,\s*["'`]package\.json/,
		);
		assert.match(resourceLoader, /resolveBinaryFactory/);
		assert.match(resourceLoader, /require\(["'`]@code-yeongyu\/senpi-codemode["'`]\)/);
	});
});
