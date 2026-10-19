import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	consumerWorkflow,
	grepBytes,
	mergeArtifacts,
	packedFiles,
	producerWorkflow,
	ptyBytes,
	runBash,
	stageArtifact,
	stepRunBlock,
	targets,
} from "./native-prebuild-staging.test-support.mjs";
import { assertPublishedWorkspacePackFiles, nativePrebuildFile } from "./senpi-publish-pack-checks.mjs";

function writePtyPackageFixture(packageDir) {
	mkdirSync(join(packageDir, "dist"), { recursive: true });
	mkdirSync(join(packageDir, "native"), { recursive: true });
	writeFileSync(
		join(packageDir, "package.json"),
		JSON.stringify({ name: "@earendil-works/pi-pty", version: "0.0.0", files: ["dist", "native"] }),
	);
	writeFileSync(join(packageDir, "dist/index.js"), "export {};\n");
	writeFileSync(join(packageDir, "native/index.js"), "export {};\n");
}

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
				assert.deepEqual(readFileSync(stagedGrep), grepBytes(target.host), `${target.host}: staged grep file holds the wrong addon`);
				const flatFiles = readdirSync(artifactDir);
				assert.ok(!flatFiles.some((file) => file.endsWith(".node")), `${target.host}: no addon may sit at the artifact root`);
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
