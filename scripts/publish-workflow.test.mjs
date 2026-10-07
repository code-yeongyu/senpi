#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

	it("stages every target's PTY prebuild from the artifact tree into the pty package", () => {
		// Given: the producer's upload root and the consumer's download destination.
		const nativeDownload = workflow.match(/- name: Download native prebuilds[\s\S]*?(?=\n      - name: Build all workspaces)/)?.[0];
		assert.ok(nativeDownload, "expected native prebuild download before workspace builds");
		assert.match(nativePrebuildWorkflow, /prebuild_dir="\$\{artifact_dir\}\/native\/prebuilds\/\$\{host\}"/);
		// The stage step copies the explicitly selected PTY addon into the loader layout;
		// index-based copies would mislabel the sorted-first grep addon as PTY.
		assert.match(nativePrebuildWorkflow, /cp "\$\{pty_file\}" "\$\{prebuild_dir\}\/senpi_pty\.\$\{host\}\.node"/);
		assert.doesNotMatch(nativePrebuildWorkflow, /node_files\[0\]/);
		// The grep addon stays in the artifact for its own consumers.
		assert.match(nativePrebuildWorkflow, /cp "\$\{grep_file\}" "\$\{artifact_dir\}\/"/);
		// The download goes to an untracked scratch root, never straight into the package.
		assert.match(nativeDownload, /path: packages\/pty\/\.native-prebuild-artifacts/);
		assert.match(nativeDownload, /merge-multiple: true/);

		// When: the staging step copies each target's PTY addon into the loader tree.
		const stagingStep = workflow.match(/- name: Stage PTY prebuilds into the pty package[\s\S]*?(?=\n      - name: Build all workspaces)/)?.[0];
		assert.ok(stagingStep, "expected the PTY prebuild staging step before workspace builds");
		assert.match(stagingStep, /if: inputs\.publish-only == true/);
		assert.match(stagingStep, /"\$\{artifacts\}"\/native\/prebuilds\/\*\/senpi_pty\.\*\.node/);
		assert.match(stagingStep, /packages\/pty\/native\/prebuilds\/\$\{target\}\/senpi_pty\.\$\{target\}\.node/);
		// The producer and consumer blocks are executed with distinct addon bytes in
		// native-prebuild-staging.test.mjs; this test only pins the workflow wiring.
	});

	it("reuses the release validation instead of rerunning the full suite", () => {
		const publishStep = workflow.match(/- name: Publish prepared version[\s\S]*?(?=\n      - name: Workflow summary)/)?.[0];
		assert.ok(publishStep, "expected publish-only step");
		assert.match(publishStep, /node scripts\/publish\.mjs/);
		// Every non-best-effort target is required; win32-arm64 stays best-effort.
		assert.match(publishStep, /--require-native-prebuilds=darwin-arm64,darwin-x64,linux-x64,linux-arm64,win32-x64/);
		assert.doesNotMatch(publishStep, /win32-arm64/);
		assert.doesNotMatch(publishStep, /npm run check|npm test/);
	});

	it("resets only tracked files, so the reset step cannot fail on a removed or untracked path", () => {
		const resetStep = workflow.match(/- name: Reset auto-generated and npm-install drift files[\s\S]*?run: git checkout -- ([^\n]+)/);
		assert.ok(resetStep, "expected the reset step");
		const paths = resetStep[1].trim().split(/\s+/).filter(Boolean);
		assert.ok(paths.length > 0, "expected reset paths");
		const repoRoot = fileURLToPath(new URL("..", import.meta.url));
		for (const path of paths) {
			const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", path], { cwd: repoRoot });
			assert.equal(tracked.status, 0, `reset path ${path} is not a tracked file`);
		}
	});

	it("keeps binary package scripts shell-executable", () => {
		assert.doesNotMatch(codingAgentPackage.scripts["copy-binary-assets"], /&&\s*&&/);
	});
});
