import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { computeKey, coveredInputs, loadTargets, normalizeRustc } from "./native-prebuild-key.mjs";

const RUSTC_VV = "rustc 1.91.0 (f8297e351 2026-10-28)\nbinary: rustc\ncommit-hash: f8297e351a40c1439a467bbbb6879088047f50b3\ncommit-date: 2026-10-28\nhost: x86_64-unknown-linux-gnu\nrelease: 1.91.0\nLLVM version: 21.1.2\n";
const RUSTC = normalizeRustc(RUSTC_VV);

const darwin = { artifact: "native-prebuild-darwin-arm64", node_platform: "darwin", node_arch: "arm64", rust_target: "aarch64-apple-darwin", cross_compile: false };
const win = { artifact: "native-prebuild-win32-x64", node_platform: "win32", node_arch: "x64", rust_target: "x86_64-pc-windows-msvc", cross_compile: false };

// One tracked file under every covered input, plus files the key must ignore.
const fixtureFiles = {
	"Cargo.toml": "[workspace]\n",
	"Cargo.lock": "version = 4\n",
	"rust-toolchain.toml": '[toolchain]\nchannel = "stable"\n',
	".github/workflows/native-prebuilds.yml": "name: Native Prebuilds\n",
	"crates/senpi-pty/src/lib.rs": "pub fn pty() {}\n",
	"crates/senpi-pty/CHANGELOG.md": "# Changelog\n",
	"crates/senpi-grep/src/lib.rs": "pub fn grep() {}\n",
	"crates/senpi-socket-secret/src/lib.rs": "pub fn secret() {}\n",
	"scripts/probe-native-pty-lifecycle.mjs": "// probe\n",
	"scripts/probe-native-grep.mjs": "// probe\n",
	"scripts/native-prebuild-key.mjs": "// key\n",
	"scripts/native-prebuild-record.mjs": "// record\n",
	"scripts/native-prebuild-reuse.mjs": "// reuse\n",
	"scripts/native-prebuild-targets.json": "[]\n",
	"packages/coding-agent/src/index.ts": "export {};\n",
};

const roots = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function git(root, ...args) {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
}

function fixtureRepo(overrides = {}) {
	const root = mkdtempSync(join(tmpdir(), "native-prebuild-key-"));
	roots.push(root);
	git(root, "init", "-q");
	for (const [path, content] of Object.entries({ ...fixtureFiles, ...overrides })) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	git(root, "add", "-A");
	return root;
}

describe("native prebuild reuse key", () => {
	it("is the same for the same inputs and has the documented shape", () => {
		const first = computeKey({ repoRoot: fixtureRepo(), target: darwin, rustc: RUSTC });
		const second = computeKey({ repoRoot: fixtureRepo(), target: darwin, rustc: RUSTC });
		assert.equal(first, second);
		assert.match(first, /^native-prebuild-v1-native-prebuild-darwin-arm64-[0-9a-f]{64}$/);
	});

	it("changes when any covered input of the target changes", () => {
		const base = computeKey({ repoRoot: fixtureRepo(), target: win, rustc: RUSTC });
		const covered = Object.keys(fixtureFiles).filter((path) => !path.endsWith(".md") && !path.startsWith("packages/"));
		for (const path of covered) {
			const changed = computeKey({ repoRoot: fixtureRepo({ [path]: `${fixtureFiles[path]}// changed\n` }), target: win, rustc: RUSTC });
			assert.notEqual(changed, base, `${path} is not covered by the win32 key`);
		}
		const added = computeKey({ repoRoot: fixtureRepo({ "crates/senpi-grep/src/new.rs": "pub fn more() {}\n" }), target: win, rustc: RUSTC });
		assert.notEqual(added, base, "a new file in a native crate is not covered");
	});

	it("changes with the resolved rustc and with the target row", () => {
		const root = fixtureRepo();
		const base = computeKey({ repoRoot: root, target: darwin, rustc: RUSTC });
		const newer = normalizeRustc(RUSTC_VV.replace("release: 1.91.0", "release: 1.91.1"));
		assert.notEqual(computeKey({ repoRoot: root, target: darwin, rustc: newer }), base);
		assert.notEqual(computeKey({ repoRoot: root, target: { ...darwin, cross_compile: true }, rustc: RUSTC }), base);
		assert.notEqual(computeKey({ repoRoot: root, target: { ...darwin, rust_target: "x86_64-apple-darwin" }, rustc: RUSTC }), base);
	});

	it("ignores markdown, files outside the native inputs, and the socket-secret crate on non-Windows targets", () => {
		const base = computeKey({ repoRoot: fixtureRepo(), target: darwin, rustc: RUSTC });
		const unrelated = {
			"crates/senpi-pty/CHANGELOG.md": "# Changelog\n\n- released\n",
			"packages/coding-agent/src/index.ts": "export const changed = 1;\n",
			"crates/senpi-socket-secret/src/lib.rs": "pub fn secret() { /* changed */ }\n",
		};
		for (const [path, content] of Object.entries(unrelated)) {
			assert.equal(computeKey({ repoRoot: fixtureRepo({ [path]: content }), target: darwin, rustc: RUSTC }), base, `${path} must not change the darwin key`);
		}
	});

	it("refuses to compute a key when a covered input is not tracked", () => {
		const root = fixtureRepo();
		git(root, "rm", "-q", "--cached", "Cargo.lock");
		assert.throws(() => computeKey({ repoRoot: root, target: darwin, rustc: RUSTC }), /Cargo\.lock/);
	});

	it("covers the socket-secret crate only for win32 targets", () => {
		assert.ok(coveredInputs(win).includes("crates/senpi-socket-secret"));
		assert.ok(!coveredInputs(darwin).includes("crates/senpi-socket-secret"));
	});

	it("reads the release version and commit from rustc -vV and rejects anything else", () => {
		assert.equal(RUSTC, "release: 1.91.0 commit-hash: f8297e351a40c1439a467bbbb6879088047f50b3");
		assert.equal(normalizeRustc(RUSTC_VV.replace("host: x86_64-unknown-linux-gnu", "host: aarch64-apple-darwin")), RUSTC);
		assert.throws(() => normalizeRustc("rustc 1.91.0\n"), /rustc -vV/);
	});

	it("loads the six release targets from the checked-in target list", () => {
		const targets = loadTargets(join(import.meta.dirname, ".."));
		assert.deepEqual(
			targets.map((target) => target.artifact),
			["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"].map((host) => `native-prebuild-${host}`),
		);
		for (const target of targets) {
			assert.equal(target.artifact, `native-prebuild-${target.node_platform}-${target.node_arch}`);
		}
	});
});
