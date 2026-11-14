#!/usr/bin/env node
// Reuse key of one native prebuild target (senpi#6622): a sha256 over every input that shapes the
// built addons, so a release can reuse a prebuild built earlier from byte-identical inputs.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const KEY_VERSION = "v1";

// Inputs of every target. The workflow file carries the build script, the matrix wiring and the
// pinned napi, zig, cargo-zigbuild and Node versions; the probe scripts are the lifecycle checks
// the build ran; the reuse scripts and target list decide what a reused prebuild is.
const COMMON_INPUTS = [
	"Cargo.toml",
	"Cargo.lock",
	"rust-toolchain.toml",
	".github/workflows/native-prebuilds.yml",
	"crates/senpi-pty",
	"crates/senpi-grep",
	"scripts/probe-native-pty-lifecycle.mjs",
	"scripts/probe-native-grep.mjs",
	"scripts/native-prebuild-key.mjs",
	"scripts/native-prebuild-record.mjs",
	"scripts/native-prebuild-reuse.mjs",
	"scripts/native-prebuild-targets.json",
];

// The socket-secret bridge is built only on Windows rows (sisyphuslabs/omo-desktop-app#4199).
const WINDOWS_INPUTS = ["crates/senpi-socket-secret"];

// Fields of a target row that select what gets built and tested.
const TARGET_FIELDS = ["artifact", "runner", "napi_target", "rust_target", "node_platform", "node_arch", "cross_compile", "napi_cross_compile", "linux"];

export function coveredInputs(target) {
	return target.node_platform === "win32" ? [...COMMON_INPUTS, ...WINDOWS_INPUTS] : [...COMMON_INPUTS];
}

export function loadTargets(repoRoot) {
	return JSON.parse(readFileSync(join(repoRoot, "scripts/native-prebuild-targets.json"), "utf8"));
}

// `rustc -vV` from the checkout: the host line differs per runner, the release and commit do not.
export function normalizeRustc(verboseVersion) {
	const release = verboseVersion.match(/^release: (\S+)$/m)?.[1];
	const commit = verboseVersion.match(/^commit-hash: (\S+)$/m)?.[1];
	if (!release || !commit) throw new Error(`expected rustc -vV output with release and commit-hash lines, got: ${verboseVersion}`);
	return `release: ${release} commit-hash: ${commit}`;
}

// Tracked files of one input, read from disk. Markdown in the crate directories (changelogs,
// trackers, agent notes) is not compiled and changes at every release cut, so it is left out.
function trackedFiles(repoRoot, input) {
	const result = spawnSync("git", ["ls-files", "-z", "--", input], { cwd: repoRoot, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ls-files ${input} failed: ${result.stderr}`);
	const files = result.stdout.split("\0").filter((path) => path !== "" && !path.endsWith(".md"));
	if (files.length === 0) throw new Error(`covered input ${input} has no tracked files; the key would silently drop it`);
	return files;
}

export function computeKey({ repoRoot, target, rustc }) {
	const lines = [`key-version ${KEY_VERSION}`, `rustc ${rustc}`];
	for (const field of TARGET_FIELDS) lines.push(`target ${field}=${JSON.stringify(target[field] ?? null)}`);
	const files = new Set(coveredInputs(target).flatMap((input) => trackedFiles(repoRoot, input)));
	for (const path of [...files].sort()) {
		const digest = createHash("sha256").update(readFileSync(join(repoRoot, path))).digest("hex");
		lines.push(`file ${path} ${digest}`);
	}
	const hash = createHash("sha256").update(`${lines.join("\n")}\n`).digest("hex");
	return `native-prebuild-${KEY_VERSION}-${target.artifact}-${hash}`;
}
