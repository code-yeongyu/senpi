import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scriptPath = join(repoRoot, "scripts", "stage-native-prebuilds.mjs");
const EXPECTED_SHA = "abc123def456";

const HOSTS = [
	{
		host: "win32-x64",
		node_platform: "win32",
		node_arch: "x64",
		ptyFile: "senpi_pty.win32-x64-msvc.node",
		grepFile: "senpi_grep.win32-x64-msvc.node",
	},
	{
		host: "win32-arm64",
		node_platform: "win32",
		node_arch: "arm64",
		ptyFile: "senpi_pty.win32-arm64-msvc.node",
		grepFile: "senpi_grep.win32-arm64-msvc.node",
	},
	{
		host: "darwin-x64",
		node_platform: "darwin",
		node_arch: "x64",
		ptyFile: "senpi_pty.darwin-x64.node",
		grepFile: "senpi_grep.darwin-x64.node",
	},
	{
		host: "darwin-arm64",
		node_platform: "darwin",
		node_arch: "arm64",
		ptyFile: "senpi_pty.darwin-arm64.node",
		grepFile: "senpi_grep.darwin-arm64.node",
	},
	{
		host: "linux-x64",
		node_platform: "linux",
		node_arch: "x64",
		ptyFile: "senpi_pty.linux-x64-gnu.2.17.node",
		grepFile: "senpi_grep.linux-x64-gnu.2.17.node",
	},
	{
		host: "linux-arm64",
		node_platform: "linux",
		node_arch: "arm64",
		ptyFile: "senpi_pty.linux-arm64-gnu.2.17.node",
		grepFile: "senpi_grep.linux-arm64-gnu.2.17.node",
	},
];

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function writeHost(artifactsDir, spec, sourceSha, shaOverride = {}) {
	const dir = join(artifactsDir, `native-prebuild-${spec.host}`);
	mkdirSync(dir, { recursive: true });
	const ptyBytes = Buffer.from(`pty:${spec.host}`);
	const grepBytes = Buffer.from(`grep:${spec.host}`);
	writeFileSync(join(dir, spec.ptyFile), ptyBytes);
	writeFileSync(join(dir, spec.grepFile), grepBytes);
	const lines = [
		`node_platform=${spec.node_platform}`,
		`node_arch=${spec.node_arch}`,
		`host=${spec.host}`,
		`file_senpi_pty=${spec.ptyFile}`,
		`file_senpi_grep=${spec.grepFile}`,
		`source_sha=${sourceSha}`,
		`sha256_senpi_pty=${shaOverride.pty ?? sha256(ptyBytes)}`,
		`sha256_senpi_grep=${shaOverride.grep ?? sha256(grepBytes)}`,
	];
	writeFileSync(join(dir, "manifest.txt"), `${lines.join("\n")}\n`);
}

function writeTree(artifactsDir, hosts, sourceSha = EXPECTED_SHA) {
	for (const spec of hosts) writeHost(artifactsDir, spec, sourceSha);
}

function runStage({ artifactsDir, rootDir, expectedSha = EXPECTED_SHA, extraArgs = [] }) {
	return spawnSync(
		process.execPath,
		[
			scriptPath,
			"--artifacts",
			artifactsDir,
			"--expected-sha",
			expectedSha,
			"--root",
			rootDir,
			...extraArgs,
		],
		{ cwd: repoRoot, encoding: "utf8" },
	);
}

function ptyDest(rootDir, host) {
	return join(rootDir, "packages", "pty", "native", "prebuilds", host, `senpi_pty.${host}.node`);
}

function grepDest(rootDir, host) {
	return join(rootDir, "packages", "coding-agent", "native", "prebuilds", host, `senpi_grep.${host}.node`);
}

describe("stage-native-prebuilds", () => {
	it("stages a synthetic artifacts tree onto host-named prebuilds", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "senpi-stage-happy-"));
		try {
			const artifactsDir = join(tempDir, "artifacts");
			const rootDir = join(tempDir, "repo");
			writeTree(artifactsDir, HOSTS);

			const result = runStage({ artifactsDir, rootDir });
			assert.equal(result.status, 0, result.stderr);

			for (const spec of HOSTS) {
				const ptyPath = ptyDest(rootDir, spec.host);
				const grepPath = grepDest(rootDir, spec.host);
				assert.equal(existsSync(ptyPath), true, `missing ${ptyPath}`);
				assert.equal(existsSync(grepPath), true, `missing ${grepPath}`);
				assert.equal(readFileSync(ptyPath, "utf8"), `pty:${spec.host}`);
				assert.equal(readFileSync(grepPath, "utf8"), `grep:${spec.host}`);
				assert.equal(existsSync(join(rootDir, "packages", "pty", "native", "prebuilds", spec.host, spec.ptyFile)), spec.ptyFile === `senpi_pty.${spec.host}.node`);
				assert.equal(
					existsSync(join(rootDir, "packages", "coding-agent", "native", "prebuilds", spec.host, spec.grepFile)),
					spec.grepFile === `senpi_grep.${spec.host}.node`,
				);
			}

			assert.match(result.stdout, /senpi_grep\.linux-x64\.node/);
			assert.doesNotMatch(result.stdout, /linux-x64-gnu/);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("exits 2 with prebuild source mismatch when source_sha differs", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "senpi-stage-sha-"));
		try {
			const artifactsDir = join(tempDir, "artifacts");
			const rootDir = join(tempDir, "repo");
			writeTree(artifactsDir, HOSTS);

			const result = runStage({ artifactsDir, rootDir, expectedSha: "deadbeef" });
			assert.equal(result.status, 2, result.stderr);
			assert.match(`${result.stdout}${result.stderr}`, /prebuild source mismatch/);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("exits 3 listing a missing required host", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "senpi-stage-required-"));
		try {
			const artifactsDir = join(tempDir, "artifacts");
			const rootDir = join(tempDir, "repo");
			writeTree(
				artifactsDir,
				HOSTS.filter((spec) => spec.host !== "linux-x64"),
			);

			const result = runStage({ artifactsDir, rootDir });
			assert.equal(result.status, 3, result.stderr);
			assert.match(`${result.stdout}${result.stderr}`, /linux-x64/);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("warns when an optional host is missing", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "senpi-stage-optional-"));
		try {
			const artifactsDir = join(tempDir, "artifacts");
			const rootDir = join(tempDir, "repo");
			writeTree(
				artifactsDir,
				HOSTS.filter((spec) => spec.host !== "win32-arm64"),
			);

			const result = runStage({
				artifactsDir,
				rootDir,
				extraArgs: ["--allow-missing-optional"],
			});
			assert.equal(result.status, 0, result.stderr);
			assert.match(`${result.stdout}${result.stderr}`, /warning/i);
			assert.match(`${result.stdout}${result.stderr}`, /win32-arm64/);
			assert.equal(existsSync(grepDest(rootDir, "linux-x64")), true);
			assert.equal(existsSync(grepDest(rootDir, "win32-arm64")), false);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("rejects a corrupted sha256", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "senpi-stage-corrupt-"));
		try {
			const artifactsDir = join(tempDir, "artifacts");
			const rootDir = join(tempDir, "repo");
			writeTree(
				artifactsDir,
				HOSTS.filter((spec) => spec.host !== "win32-x64"),
			);
			writeHost(artifactsDir, HOSTS[0], EXPECTED_SHA, {
				pty: "0".repeat(64),
			});

			const result = runStage({ artifactsDir, rootDir });
			assert.notEqual(result.status, 0);
			assert.notEqual(result.status, 2);
			assert.notEqual(result.status, 3);
			assert.match(`${result.stdout}${result.stderr}`, /sha256/i);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
