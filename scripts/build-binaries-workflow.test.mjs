#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { describe, it } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/build-binaries.yml", import.meta.url), "utf8");
const buildScriptUrl = new URL("./build-binaries.sh", import.meta.url);
const buildScript = readFileSync(buildScriptUrl, "utf8");
const codingAgentPackage = JSON.parse(
	readFileSync(new URL("../packages/coding-agent/package.json", import.meta.url), "utf8"),
);

describe("binary release workflow", () => {
	it("pins a stable Bun release with downloadable cross-compile executables", () => {
		assert.match(workflow, /bun-version:\s*['"]1\.4\.2['"]/);
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

	it("omits jsdom's retired sync worker from release binaries", () => {
		if (process.platform !== "win32") {
			assert.notEqual(statSync(buildScriptUrl).mode & 0o111, 0);
		}
		assert.match(buildScript, /node scripts\/prepare-bun-compile-assets\.mjs/);
		assert.doesNotMatch(buildScript, /node_modules\/jsdom\/lib\/jsdom\/living\/xhr\/xhr-sync-worker\.js/);
		assert.match(buildScript, /smoke-standalone-binary\.mjs/);
	});

	it("keeps the package binary build aligned with release packaging", () => {
		const binaryBuild = codingAgentPackage.scripts["build:binary"];
		assert.match(binaryBuild, /npm --prefix \.\.\/pty run build/);
		assert.match(binaryBuild, /node \.\.\/\.\.\/scripts\/prepare-bun-compile-assets\.mjs/);
		assert.doesNotMatch(binaryBuild, /node_modules\/jsdom\/lib\/jsdom\/living\/xhr\/xhr-sync-worker\.js/);
		assert.doesNotMatch(binaryBuild, /--external=css-tree/);
	});

	it("stages the codemode sidecar before executing the release smoke", () => {
		// Given: the release driver's executable Node script invocations.
		const scripts = [...buildScript.matchAll(/^\s*node\s+"?([^"\s]+\.mjs)"?/gm)]
			.map((match) => basename(match[1]));
		// When: selecting the staging and smoke commands in execution order.
		const codemodePipeline = scripts.filter((script) =>
			["copy-codemode-sidecar.mjs", "smoke-standalone-binary.mjs"].includes(script));
		// Then: the payload exists before smoke. The CI release-graph gate checks bundle bytes.
		assert.deepEqual(codemodePipeline, ["copy-codemode-sidecar.mjs", "smoke-standalone-binary.mjs"]);
		assert.match(codingAgentPackage.scripts["copy-binary-assets"], /copy-codemode-sidecar\.mjs dist/);
	});
});
