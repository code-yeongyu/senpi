import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { checkPrebuildFreshness } from "../packages/pty/native/check-prebuild-fresh.mjs";

test("fails with the host target name when the vendored prebuild is missing", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "senpi-pty-prebuild-missing-"));
	try {
		await assert.rejects(
			checkPrebuildFreshness({
				builtFile: join(tempDir, "built.node"),
				host: "darwin-arm64",
				rootDir: tempDir,
				skipBuild: true,
			}),
			/error: missing vendored prebuild for darwin-arm64/,
		);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("fails with the host target name when the vendored prebuild is stale", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "senpi-pty-prebuild-stale-"));
	try {
		const builtFile = join(tempDir, "built.node");
		const vendoredDir = join(tempDir, "packages", "pty", "native", "prebuilds", "darwin-arm64");
		await mkdir(vendoredDir, { recursive: true });
		await writeFile(builtFile, "fresh");
		await writeFile(join(vendoredDir, "senpi_pty.darwin-arm64.node"), "stale");

		await assert.rejects(
			checkPrebuildFreshness({
				builtFile,
				host: "darwin-arm64",
				rootDir: tempDir,
				skipBuild: true,
			}),
			/error: stale vendored prebuild for darwin-arm64/,
		);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("passes when the host prebuild matches the rebuilt artifact", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "senpi-pty-prebuild-fresh-"));
	try {
		const builtFile = join(tempDir, "built.node");
		const vendoredDir = join(tempDir, "packages", "pty", "native", "prebuilds", "darwin-arm64");
		await mkdir(vendoredDir, { recursive: true });
		await writeFile(builtFile, "fresh");
		await writeFile(join(vendoredDir, "senpi_pty.darwin-arm64.node"), "fresh");

		const result = await checkPrebuildFreshness({
			builtFile,
			host: "darwin-arm64",
			rootDir: tempDir,
			skipBuild: true,
		});

		assert.equal(result.host, "darwin-arm64");
		assert.equal(result.status, "fresh");
		assert.match(result.vendoredFile, /senpi_pty\.darwin-arm64\.node$/);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});
