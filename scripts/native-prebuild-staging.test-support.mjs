import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseNpmPackJson } from "./npm-pack-json.mjs";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const producerWorkflow = readFileSync(join(repoRoot, ".github/workflows/native-prebuilds.yml"), "utf8");
export const consumerWorkflow = readFileSync(join(repoRoot, ".github/workflows/publish-npm.yml"), "utf8");

// The `run: |` block of the named step, dedented. Reading it from the workflow text keeps
// the test bound to the shell that Actions executes instead of a copy that can drift.
export function stepRunBlock(workflow, stepName) {
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

export function runBash(script, { cwd, env }) {
	const result = spawnSync("bash", ["-c", script], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
	assert.equal(result.error, undefined, `bash is required to run the workflow step: ${result.error?.message}`);
	return result;
}

// One matrix row, as native-prebuilds.yml exposes it to the Stage artifact step.
export const targets = [
	{ host: "linux-x64", platform: "linux", arch: "x64", napi: "x86_64-unknown-linux-gnu.2.17", rust: "x86_64-unknown-linux-gnu", built: "linux-x64-gnu" },
	{ host: "darwin-arm64", platform: "darwin", arch: "arm64", napi: "aarch64-apple-darwin", rust: "aarch64-apple-darwin", built: "darwin-arm64" },
];

export const ptyBytes = (host) => Buffer.from(`senpi_pty addon bytes for ${host}\n`);
export const grepBytes = (host) => Buffer.from(`senpi_grep addon bytes for ${host}\n`);

// Runs the producer's Stage artifact step for one matrix row against a napi output dir that
// holds BOTH addons with distinct bytes, and returns the staged artifact directory.
export function stageArtifact(root, target, producerScript = stepRunBlock(producerWorkflow, "Stage artifact")) {
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
export function mergeArtifacts(artifactDirs, destination) {
	mkdirSync(destination, { recursive: true });
	for (const artifactDir of artifactDirs) {
		cpSync(artifactDir, destination, { recursive: true });
	}
}

export function packedFiles(packageDir) {
	const result = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { cwd: packageDir, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return parseNpmPackJson(result.stdout)[0];
}

export function packedPathSet(packed) {
	return new Set(packed.files.map((file) => file.path.replace(/^package\//, "")));
}
