import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseNpmPackJson } from "./npm-pack-json.mjs";
import { assertPublishedWorkspacePackFiles, nativePrebuildFile } from "./senpi-publish-pack-checks.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const producerWorkflow = readFileSync(join(repoRoot, ".github/workflows/native-prebuilds.yml"), "utf8");
const consumerWorkflow = readFileSync(join(repoRoot, ".github/workflows/publish-npm.yml"), "utf8");

// The `run: |` block of the named step, dedented. Reading it from the workflow text keeps
// the test bound to the shell that Actions executes instead of a copy that can drift.
function stepRunBlock(workflow, stepName) {
	const lines = workflow.split("\n");
	const nameIndex = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
	assert.notEqual(nameIndex, -1, `workflow step "${stepName}" not found`);
	const runIndex = lines.findIndex((line, index) => index > nameIndex && line.trim() === "run: |");
	assert.notEqual(runIndex, -1, `workflow step "${stepName}" has no run: | block`);
	const nextStep = lines.findIndex((line, index) => index > nameIndex && index !== nameIndex && line.trim().startsWith("- name: "));
	assert.ok(nextStep === -1 || runIndex < nextStep, `workflow step "${stepName}" run block belongs to another step`);
	const keyIndent = lines[runIndex].match(/^\s*/)[0].length;
	const body = [];
	for (let index = runIndex + 1; index < lines.length; index++) {
		const line = lines[index];
		if (line.trim() === "") {
			body.push("");
			continue;
		}
		if (line.match(/^\s*/)[0].length <= keyIndent) break;
		body.push(line);
	}
	const indent = Math.min(...body.filter((line) => line.trim() !== "").map((line) => line.match(/^\s*/)[0].length));
	return body.map((line) => line.slice(indent)).join("\n");
}

function runBash(script, { cwd, env }) {
	const result = spawnSync("bash", ["-c", script], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
	assert.equal(result.error, undefined, `bash is required to run the workflow step: ${result.error?.message}`);
	return result;
}

// One matrix row, as native-prebuilds.yml exposes it to the Stage artifact step.
const targets = [
	{ host: "linux-x64", platform: "linux", arch: "x64", napi: "x86_64-unknown-linux-gnu.2.17", rust: "x86_64-unknown-linux-gnu", built: "linux-x64-gnu" },
	{ host: "darwin-arm64", platform: "darwin", arch: "arm64", napi: "aarch64-apple-darwin", rust: "aarch64-apple-darwin", built: "darwin-arm64" },
];

const ptyBytes = (host) => Buffer.from(`senpi_pty addon bytes for ${host}\n`);
const grepBytes = (host) => Buffer.from(`senpi_grep addon bytes for ${host}\n`);

// Runs the producer's Stage artifact step for one matrix row against a napi output dir that
// holds BOTH addons with distinct bytes, and returns the staged artifact directory.
function stageArtifact(root, target, producerScript = stepRunBlock(producerWorkflow, "Stage artifact")) {
	const runnerTemp = join(root, "runner", target.host);
	const outputDir = join(runnerTemp, "native-prebuild-output", target.built);
	mkdirSync(outputDir, { recursive: true });
	// napi writes the grep addon first in sort order, which is what made an index-based copy wrong.
	writeFileSync(join(outputDir, `senpi_grep.${target.built}.node`), grepBytes(target.host));
	writeFileSync(join(outputDir, `senpi_pty.${target.built}.node`), ptyBytes(target.host));
	const script = producerScript.replaceAll("${{ matrix.artifact }}", `native-prebuild-${target.host}`);
	const result = runBash(script, {
		cwd: root,
		env: {
			RUNNER_TEMP: runnerTemp,
			NODE_PLATFORM: target.platform,
			NODE_ARCH: target.arch,
			NAPI_TARGET: target.napi,
			RUST_TARGET: target.rust,
		},
	});
	return { result, artifactDir: join(runnerTemp, "native-prebuild-artifact") };
}

// Mirrors actions/download-artifact with `pattern: native-prebuild-*` and `merge-multiple: true`:
// every artifact's content lands in one directory.
function mergeArtifacts(artifactDirs, destination) {
	mkdirSync(destination, { recursive: true });
	for (const artifactDir of artifactDirs) {
		cpSync(artifactDir, destination, { recursive: true });
	}
}

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

function packedFiles(packageDir) {
	const result = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { cwd: packageDir, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return parseNpmPackJson(result.stdout)[0];
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
				const flatFiles = readdirSync(artifactDir);
				assert.ok(flatFiles.includes(`senpi_grep.${target.built}.node`), `${target.host}: grep addon missing from the artifact root`);
				assert.ok(!flatFiles.some((file) => file.startsWith("senpi_pty.")), `${target.host}: PTY addon must not sit at the artifact root`);
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
