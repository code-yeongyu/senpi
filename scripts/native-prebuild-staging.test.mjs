import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadTargets } from "./native-prebuild-key.mjs";
import { recordFileName, verifyRecord, writeRecord } from "./native-prebuild-record.mjs";
import { assertPublishedWorkspacePackFiles, nativePrebuildFile } from "./senpi-publish-pack-checks.mjs";
import {
	consumerWorkflow,
	grepBytes,
	mergeArtifacts,
	packedFiles,
	packedPathSet,
	producerWorkflow,
	ptyBytes,
	repoRoot,
	runBash,
	secretBytes,
	stageArtifact,
	stepRunBlock,
	targets,
	windowsTargets,
	writePtyPackageFixture,
} from "./native-prebuild-staging.test-support.mjs";


describe("native prebuild staging (producer -> download -> pty package)", () => {
	it("stages each target's PTY addon, not the grep addon, where the pty loader and the pack guard look", () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-native-staging-"));
		try {
			// Given: the real Stage artifact step runs for two matrix rows with distinct addon bytes.
			const artifactDirs = [];
			for (const target of targets) {
				const { result, artifactDir } = stageArtifact(root, target);
				assert.equal(result.status, 0, `${target.host}: ${result.stderr}`);
				const stagedPty = join(artifactDir, "native/prebuilds", target.host, `senpi_pty.${target.host}.node`);
				assert.ok(existsSync(stagedPty), `${target.host}: producer did not stage ${stagedPty}`);
				assert.deepEqual(readFileSync(stagedPty), ptyBytes(target.host), `${target.host}: staged PTY file holds the wrong addon`);
				const stagedGrep = join(artifactDir, "native/prebuilds", target.host, `senpi_grep.${target.host}.node`);
				assert.ok(existsSync(stagedGrep), `${target.host}: producer did not stage the grep addon at the loader path`);
				assert.deepEqual(readFileSync(stagedGrep), grepBytes(target.host), `${target.host}: staged grep file holds the wrong addon`);
				const flatFiles = readdirSync(artifactDir);
				assert.ok(!flatFiles.some((file) => file.startsWith("senpi_pty.") || file.startsWith("senpi_grep.")), `${target.host}: addons must not sit at the artifact root`);
				const manifest = readFileSync(join(artifactDir, "manifest.txt"), "utf8");
				assert.match(manifest, new RegExp(`^file_senpi_pty=senpi_pty\\.${target.built}\\.node$`, "m"));
				assert.match(manifest, new RegExp(`^file_senpi_grep=senpi_grep\\.${target.built}\\.node$`, "m"));
				artifactDirs.push(artifactDir);
			}

			// When: the publish-only job downloads the merged artifacts and runs its staging step.
			const checkout = join(root, "checkout");
			const packageDir = join(checkout, "packages/pty");
			writePtyPackageFixture(packageDir);
			mergeArtifacts(artifactDirs, join(packageDir, ".native-prebuild-artifacts"));
			const consumer = runBash(stepRunBlock(consumerWorkflow, "Stage PTY prebuilds into the pty package"), { cwd: checkout, env: {} });
			assert.equal(consumer.status, 0, consumer.stderr);

			// Then: every target's PTY bytes sit at the loader-relative path and nothing else leaked in.
			for (const target of targets) {
				const staged = join(packageDir, "native/prebuilds", target.host, `senpi_pty.${target.host}.node`);
				assert.ok(existsSync(staged), `${target.host}: consumer did not stage ${staged}`);
				assert.deepEqual(readFileSync(staged), ptyBytes(target.host), `${target.host}: consumer staged the wrong addon bytes`);
				const siblings = readdirSync(join(packageDir, "native/prebuilds", target.host));
				assert.deepEqual(siblings, [`senpi_pty.${target.host}.node`], `${target.host}: unexpected files beside the PTY addon`);
			}

			// And: the packed tarball carries exactly those prebuilds, so the live guard accepts them
			// and still rejects a required target the staging did not produce.
			const packed = packedFiles(packageDir);
			const packedPaths = new Set(packed.files.map((file) => file.path.replace(/^package\//, "")));
			for (const target of targets) {
				assert.ok(packedPaths.has(nativePrebuildFile(target.host, "@earendil-works/pi-pty")), `${target.host}: prebuild missing from the tarball`);
			}
			assert.ok(![...packedPaths].some((path) => path.includes(".native-prebuild-artifacts") || path.includes("senpi_grep.")), "scratch download root or grep addon leaked into the tarball");
			assert.doesNotThrow(() =>
				assertPublishedWorkspacePackFiles(packed, "@earendil-works/pi-pty", { requiredNativePrebuildTargets: targets.map((target) => target.host) }),
			);
			assert.throws(
				() => assertPublishedWorkspacePackFiles(packed, "@earendil-works/pi-pty", { requiredNativePrebuildTargets: [...targets.map((target) => target.host), "win32-x64"] }),
				/native\/prebuilds\/win32-x64\/senpi_pty\.win32-x64\.node/,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails when the producer stages nothing or swaps the addons", () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-native-staging-mutant-"));
		try {
			const target = targets[0];
			const producer = stepRunBlock(producerWorkflow, "Stage artifact");

			// A producer that exits before copying leaves no PTY file behind.
			const silent = producer.replace(/set -euo pipefail\n/, "set -euo pipefail\nexit 0\n");
			assert.notEqual(silent, producer, "mutation did not apply");
			const { result: silentResult, artifactDir: silentDir } = stageArtifact(join(root, "silent"), target, silent);
			assert.equal(silentResult.status, 0);
			assert.ok(!existsSync(join(silentDir, "native/prebuilds", target.host, `senpi_pty.${target.host}.node`)), "silent producer must leave no staged PTY file");

			// A producer that copies the grep addon under the PTY name stages the wrong bytes.
			const swapped = producer.replace('cp "${pty_file}" "${prebuild_dir}/senpi_pty.${host}.node"', 'cp "${grep_file}" "${prebuild_dir}/senpi_pty.${host}.node"');
			assert.notEqual(swapped, producer, "mutation did not apply");
			const { result: swappedResult, artifactDir: swappedDir } = stageArtifact(join(root, "swapped"), target, swapped);
			assert.equal(swappedResult.status, 0);
			const staged = readFileSync(join(swappedDir, "native/prebuilds", target.host, `senpi_pty.${target.host}.node`));
			assert.notDeepEqual(staged, ptyBytes(target.host), "swapped producer must not pass as the PTY addon");
			assert.deepEqual(staged, grepBytes(target.host));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

// senpi#6622: a release may download every target as a reused artifact (re-uploaded by the plan job
// from the cache, record included). The publish-only staging must still stage all six targets.
describe("release staging from reused prebuilds", () => {
	it("stages all six PTY prebuilds and both socket-secret bridges, and leaves the records in the scratch root", () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-reused-staging-"));
		try {
			const rows = loadTargets(repoRoot);
			const rustc = "release: 1.91.0 commit-hash: f8297e351a40c1439a467bbbb6879088047f50b3";
			const artifactDirs = rows.map((row) => {
				const host = `${row.node_platform}-${row.node_arch}`;
				const built = row.rust_target.includes("linux") ? `${host}-gnu` : row.node_platform === "win32" ? `${host}-msvc` : host;
				const { result, artifactDir } = stageArtifact(root, { host, platform: row.node_platform, arch: row.node_arch, napi: row.napi_target, rust: row.rust_target, built });
				assert.equal(result.status, 0, `${host}: ${result.stderr}`);
				const key = `native-prebuild-v1-${row.artifact}-${"0".repeat(64)}`;
				writeRecord({ artifactDir, target: row, key, rustc });
				assert.deepEqual(verifyRecord({ artifactDir, target: row, key, rustc }), { ok: true });
				return artifactDir;
			});

			const checkout = join(root, "checkout");
			const packageDir = join(checkout, "packages/pty");
			writePtyPackageFixture(packageDir);
			mkdirSync(join(checkout, "packages/coding-agent"), { recursive: true });
			mergeArtifacts(artifactDirs, join(packageDir, ".native-prebuild-artifacts"));
			for (const step of ["Stage PTY prebuilds into the pty package", "Stage the socket-secret bridge into the coding-agent package"]) {
				const consumer = runBash(stepRunBlock(consumerWorkflow, step), { cwd: checkout, env: {} });
				assert.equal(consumer.status, 0, `${step}: ${consumer.stderr}`);
			}

			const hosts = rows.map((row) => `${row.node_platform}-${row.node_arch}`);
			for (const host of hosts) {
				assert.deepEqual(readFileSync(join(packageDir, "native/prebuilds", host, `senpi_pty.${host}.node`)), ptyBytes(host), `${host}: PTY prebuild`);
				assert.ok(existsSync(join(packageDir, ".native-prebuild-artifacts", recordFileName({ node_platform: host.split("-")[0], node_arch: host.split("-")[1] }))));
			}
			for (const host of ["win32-x64", "win32-arm64"]) {
				const bridge = join(checkout, "packages/coding-agent/native/socket-secret/prebuilds", host, `senpi_socket_secret.${host}.node`);
				assert.deepEqual(readFileSync(bridge), secretBytes(host), `${host}: socket-secret bridge`);
			}
			const packedPaths = packedPathSet(packedFiles(packageDir));
			assert.ok(![...packedPaths].some((path) => path.includes("native-prebuild-record")), "a reuse record leaked into the pty tarball");
			for (const host of hosts) assert.ok(packedPaths.has(nativePrebuildFile(host, "@earendil-works/pi-pty")), `${host}: prebuild missing from the tarball`);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

// sisyphuslabs/omo-desktop-app#4199: Windows rows also build the socket-secret bridge, which has no fallback.
describe("socket-secret bridge staging (Windows rows -> coding-agent package)", () => {
	it("stages each Windows bridge where the loader and the publish step look", () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-secret-staging-"));
		try {
			const artifactDirs = [];
			for (const target of windowsTargets) {
				const { result, artifactDir } = stageArtifact(root, target);
				assert.equal(result.status, 0, `${target.host}: ${result.stderr}`);
				const staged = join(artifactDir, "native/socket-secret/prebuilds", target.host, `senpi_socket_secret.${target.host}.node`);
				assert.deepEqual(readFileSync(staged), secretBytes(target.host));
				const manifest = readFileSync(join(artifactDir, "manifest.txt"), "utf8");
				assert.match(manifest, new RegExp(`^file_senpi_socket_secret=senpi_socket_secret\\.${target.built}\\.node$`, "m"));
				artifactDirs.push(artifactDir);
			}
			const checkout = join(root, "checkout");
			mkdirSync(join(checkout, "packages/coding-agent"), { recursive: true });
			mergeArtifacts(artifactDirs, join(checkout, "packages/pty/.native-prebuild-artifacts"));
			const consumer = runBash(stepRunBlock(consumerWorkflow, "Stage the socket-secret bridge into the coding-agent package"), { cwd: checkout, env: {} });
			assert.equal(consumer.status, 0, consumer.stderr);
			for (const target of windowsTargets) {
				const file = join(checkout, "packages/coding-agent/native/socket-secret/prebuilds", target.host, `senpi_socket_secret.${target.host}.node`);
				assert.deepEqual(readFileSync(file), secretBytes(target.host));
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails a Windows row whose napi output lacks the bridge", () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-secret-missing-"));
		try {
			const { result } = stageArtifact(root, { ...windowsTargets[0], withSecret: false });
			assert.notEqual(result.status, 0);
			assert.match(result.stdout + result.stderr, /expected 3 \.node files/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("blocks the publish when only one Windows bridge was downloaded", () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-secret-partial-"));
		try {
			const { result, artifactDir } = stageArtifact(root, windowsTargets[0]);
			assert.equal(result.status, 0, result.stderr);
			const checkout = join(root, "checkout");
			mkdirSync(join(checkout, "packages/coding-agent"), { recursive: true });
			mergeArtifacts([artifactDir], join(checkout, "packages/pty/.native-prebuild-artifacts"));
			const consumer = runBash(stepRunBlock(consumerWorkflow, "Stage the socket-secret bridge into the coding-agent package"), { cwd: checkout, env: {} });
			assert.notEqual(consumer.status, 0);
			assert.match(consumer.stdout + consumer.stderr, /missing socket-secret bridge for win32-arm64/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
