#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
		assert.match(workflow, /native-prebuilds:\s+(?:needs: require-version\s+)?(?:if: [^\n]+\s+)?uses: \.\/\.github\/workflows\/native-prebuilds\.yml/);
		assert.match(workflow, /native-prebuilds:\s+needs: require-version\s+if: \$\{\{ inputs\.publish-only == true \}\}\s+uses:/);
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

	it("releases the dispatched sha when one is given, through release.mjs --sha", () => {
		assert.match(workflow, /\n      sha:\n        description: [^\n]+\n        required: false\n        type: string\n        default: ''/);
		const releaseStep = workflow.match(/- name: Run release[\s\S]*?npm run release -- "\$\{ARGS\[@\]\}"/)?.[0];
		assert.ok(releaseStep, "expected the release step");
		// The sha reaches the shell through env, never pasted into the script text.
		assert.match(releaseStep, /RELEASE_SHA: \$\{\{ inputs\.sha \}\}/);
		assert.match(releaseStep, /if \[ -n "\$RELEASE_SHA" \]; then\n\s+ARGS\+=\(--sha "\$RELEASE_SHA"\)/);
		assert.doesNotMatch(releaseStep.slice(releaseStep.indexOf("run: |")), /inputs\.sha/);
	});

	it("keeps binary package scripts shell-executable", () => {
		assert.doesNotMatch(codingAgentPackage.scripts["copy-binary-assets"], /&&\s*&&/);
	});
});

describe("release step TypeScript heap", () => {
	it("runs the release's npm run check with the same heap as the CI Check step", () => {
		const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
		const ciCheck = ci.match(/- name: Check\n[\s\S]*?run: npm run check/)?.[0];
		assert.ok(ciCheck, "expected the CI Check step");
		const ciHeap = ciCheck.match(/NODE_OPTIONS: (--max-old-space-size=\d+)/)?.[1];
		assert.ok(ciHeap, "expected a heap size on the CI Check step");
		const release = workflow.match(/- name: Run release\n[\s\S]*?\n        run: \|/)?.[0];
		assert.ok(release, "expected the Run release step");
		assert.equal(release.match(/NODE_OPTIONS: (--max-old-space-size=\d+)/)?.[1], ciHeap);
	});
});

describe("publish-only builds the tagged commit", () => {
	const checkout = workflow.match(/- name: Checkout\n[\s\S]*?(?=\n      - name: )/)?.[0];
	const guard = workflow.match(/- name: Refuse to publish anything but the tagged commit\n[\s\S]*?(?=\n      - name: )/)?.[0];

	it("checks out refs/tags/v<version> in publish-only mode", () => {
		assert.ok(checkout, "expected the Checkout step");
		assert.match(checkout, /ref: \$\{\{ inputs\.publish-only && format\('refs\/tags\/v\{0\}', inputs\.version\) \|\| '' \}\}/);
	});

	it("refuses to publish when HEAD is not the tag's commit, before anything is installed or built", () => {
		assert.ok(guard, "expected the tagged-commit guard step");
		assert.match(guard, /if: inputs\.publish-only == true/);
		assert.match(guard, /git rev-parse --verify "refs\/tags\/v\$\{EXPECTED_VERSION\}\^\{commit\}"/);
		assert.match(guard, /test "\$head_commit" = "\$tag_commit" \|\|/);
		assert.ok(
			workflow.indexOf("- name: Refuse to publish anything but the tagged commit") <
				workflow.indexOf("- name: Install dependencies"),
			"the guard runs before dependencies are installed",
		);
	});
});

describe("publish-only native addons and inputs", () => {
	const nativeWorkflow = readFileSync(new URL("../.github/workflows/native-prebuilds.yml", import.meta.url), "utf8");

	it("builds the native prebuilds from the same tag as the JS", () => {
		const call = workflow.match(/  native-prebuilds:\n[\s\S]*?(?=\n  [a-z-]+:\n)/)?.[0];
		assert.ok(call, "expected the native-prebuilds job");
		assert.match(call, /with:\s+(?:#[^\n]*\s+)*ref: refs\/tags\/v\$\{\{ inputs\.version \}\}/);
		assert.match(nativeWorkflow, /workflow_call:\s+inputs:[\s\S]*?\n      ref:\n[\s\S]*?default: ''/);
		const checkout = nativeWorkflow.match(/- name: Checkout\n[\s\S]*?(?=\n      - name: )/)?.[0];
		assert.ok(checkout, "expected the native-prebuilds Checkout step");
		assert.match(checkout, /ref: \$\{\{ inputs\.ref \|\| '' \}\}/);
	});

	it("fails an empty publish-only version with the guard's message before native-prebuilds runs", () => {
		const job = workflow.match(/  require-version:\n[\s\S]*?(?=\n  [a-z-]+:\n)/)?.[0];
		assert.ok(job, "expected the require-version job");
		assert.match(job, /if: \$\{\{ inputs\.publish-only == true \}\}/);
		assert.match(workflow, /  native-prebuilds:\n    needs: require-version\n/);
		const script = job.match(/run: \|\n([\s\S]*)/)?.[1].replace(/^ {10}/gm, "");
		assert.ok(script, "expected the guard script");
		const run = (version) => spawnSync("bash", ["-c", script], { env: { PATH: process.env.PATH, EXPECTED_VERSION: version }, encoding: "utf8" });
		const empty = run("");
		assert.equal(empty.status, 1);
		assert.match(empty.stderr, /publish-only requires an explicit version/);
		assert.equal(run("2026.10.23-1").status, 0);
	});

	it("reports the published commit in the run summary for publish-only, and the dispatch commit otherwise", () => {
		const step = workflow.match(/- name: Workflow summary\n[\s\S]*?run: \|\n([\s\S]*?)(?=\n\n|\n      - name: |$)/)?.[1];
		assert.ok(step, "expected the Workflow summary script");
		const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
		const render = (publishOnly) => {
			const script = step
				.replace(/^ {10}/gm, "")
				.replaceAll("${{ inputs.publish-only }}", String(publishOnly))
				.replace(/commit="\$\{\{[^}]*\}\}"/, 'commit="DISPATCHSHA"')
				.replace(/\$\{\{[^}]*\}\}/g, "x");
			const summary = join(mkdtempSync(join(tmpdir(), "publish-summary-")), "summary.md");
			const result = spawnSync("bash", ["-c", script], {
				encoding: "utf8",
				env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summary },
			});
			assert.equal(result.status, 0, result.stderr);
			return readFileSync(summary, "utf8").match(/\| Commit \| (.*) \|/)?.[1];
		};
		assert.equal(render(true), head);
		assert.equal(render(false), "DISPATCHSHA");
	});
});
