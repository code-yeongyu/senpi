#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const nativePrebuildWorkflow = readFileSync(new URL("../.github/workflows/native-prebuilds.yml", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../.github/workflows/publish-npm.yml", import.meta.url), "utf8");
const codingAgentPackage = JSON.parse(
	readFileSync(new URL("../packages/coding-agent/package.json", import.meta.url), "utf8"),
);

describe("publish-only workflow", () => {
	it("installs release dependencies without native lifecycle scripts", () => {
		const installStep = workflow.match(/- name: Install dependencies[\s\S]*?(?=\n      - name: Build all workspaces)/)?.[0];
		assert.ok(installStep, "expected dependency install step");
		assert.match(installStep, /npm install --ignore-scripts --no-audit --no-fund/);
	});

	it("calls native prebuilds and stages their consumer-ready artifacts before building", () => {
		assert.match(nativePrebuildWorkflow, /workflow_call:/);
		assert.match(
			nativePrebuildWorkflow,
			/path: \$\{\{ runner\.temp \}\}\/native-prebuild-artifact\s*$/m,
		);
		assert.match(workflow, /native-prebuilds:\s+(?:if: [^\n]+\s+)?uses: \.\/\.github\/workflows\/native-prebuilds\.yml/);
		assert.match(workflow, /native-prebuilds:\s+if: \$\{\{ inputs\.publish-only == true \}\}\s+uses:/);
		assert.match(
			workflow,
			/needs: native-prebuilds\s+if: \$\{\{ always\(\) && \(inputs\.publish-only != true \|\| needs\.native-prebuilds\.result == 'success'\) \}\}/,
		);
		const nativeDownload = workflow.match(/- name: Download native prebuilds[\s\S]*?(?=\n      - name: Build all workspaces)/)?.[0];
		assert.ok(nativeDownload, "expected native prebuild download before workspace builds");
		assert.match(nativeDownload, /if: inputs\.publish-only == true/);
		assert.match(nativeDownload, /pattern: native-prebuild-\*/);
		assert.match(nativeDownload, /path: packages\/pty/);
		assert.match(nativeDownload, /merge-multiple: true/);
	});

	it("places the Linux x64 prebuild from the upload root in the pty package", () => {
		// Given: the producer's upload root and the consumer's download destination.
		const relativePrebuild = "native/prebuilds/linux-x64/senpi_pty.linux-x64.node";
		const nativeDownload = workflow.match(/- name: Download native prebuilds[\s\S]*?(?=\n      - name: Build all workspaces)/)?.[0];
		assert.ok(nativeDownload, "expected native prebuild download before workspace builds");
		assert.match(nativePrebuildWorkflow, /prebuild_dir="\$\{artifact_dir\}\/native\/prebuilds\/\$\{host\}"/);
		assert.match(nativePrebuildWorkflow, /cp "\$\{node_files\[0\]\}" "\$\{prebuild_dir\}\/senpi_pty\.\$\{host\}\.node"/);
		assert.match(nativeDownload, /path: packages\/pty/);

		// When: the artifact downloader merges the producer's root into packages/pty.
		const downloadedPrebuild = `packages/pty/${relativePrebuild}`;

		// Then: the packaged PTY loader sees the exact Linux x64 prebuild path.
		assert.equal(downloadedPrebuild, "packages/pty/native/prebuilds/linux-x64/senpi_pty.linux-x64.node");
	});

	it("reuses the release validation instead of rerunning the full suite", () => {
		const publishStep = workflow.match(/- name: Publish prepared version[\s\S]*?(?=\n      - name: Workflow summary)/)?.[0];
		assert.ok(publishStep, "expected publish-only step");
		assert.match(publishStep, /node scripts\/publish\.mjs/);
		assert.match(publishStep, /--require-native-prebuild=linux-x64/);
		assert.doesNotMatch(publishStep, /npm run check|npm test/);
	});

	it("keeps binary package scripts shell-executable", () => {
		assert.doesNotMatch(codingAgentPackage.scripts["copy-binary-assets"], /&&\s*&&/);
	});
});
