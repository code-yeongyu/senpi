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

	it("consumes native prebuilds before building binaries", () => {
		assert.match(workflow, /uses:\s*\.\/\.github\/workflows\/native-prebuilds\.yml/);
		assert.match(workflow, /^\s+needs:\s*prebuilds\s*$/m);

		const sourceRefExpr =
			"${{ github.event.inputs.source_ref || github.event.inputs.tag || github.ref_name }}";
		const sourceRefMatch = workflow.match(/SOURCE_REF:\s*(\$\{\{[^}]+\}\})/);
		assert.ok(sourceRefMatch, "expected SOURCE_REF expression");
		assert.equal(sourceRefMatch[1], sourceRefExpr);

		const withSourceRefMatch = workflow.match(
			/uses:\s*\.\/\.github\/workflows\/native-prebuilds\.yml[\s\S]*?source_ref:\s*(\$\{\{[^}]+\}\})/,
		);
		assert.ok(withSourceRefMatch, "expected prebuilds.with.source_ref expression");
		assert.equal(withSourceRefMatch[1], sourceRefMatch[1]);

		const stageIdx = workflow.indexOf("scripts/stage-native-prebuilds.mjs");
		const buildIdx = workflow.indexOf("./scripts/build-binaries.sh");
		assert.notEqual(stageIdx, -1, "expected stage-native-prebuilds.mjs step");
		assert.notEqual(buildIdx, -1, "expected build-binaries.sh step");
		assert.ok(stageIdx < buildIdx, "stage step must precede build-binaries.sh");
	});

	it("forwards the prebuild run id to the publish dispatch", () => {
		assert.match(workflow, /prebuild_run_id=\$\{\{ github\.run_id \}\}/);
	});
});
