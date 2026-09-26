import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { checkPrebuildFreshness, getBinaryName } from "../packages/desktop-engine/native/check-prebuild-fresh.mjs";

const vendoredDir = (root, host) => join(root, "packages", "desktop-engine", "native", "prebuilds", host);

test("fails with the host target name when the vendored engine prebuild is missing", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "senpi-desktop-engine-prebuild-missing-"));
	try {
		await assert.rejects(
			checkPrebuildFreshness({ builtFile: join(tempDir, "built"), host: "darwin-arm64", rootDir: tempDir }),
			/error: missing vendored prebuild for darwin-arm64/,
		);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("fails with the host target name when the vendored engine prebuild is stale", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "senpi-desktop-engine-prebuild-stale-"));
	try {
		const builtFile = join(tempDir, "built");
		await mkdir(vendoredDir(tempDir, "darwin-arm64"), { recursive: true });
		await writeFile(builtFile, "fresh");
		await writeFile(join(vendoredDir(tempDir, "darwin-arm64"), "senpi-desktop-engine"), "stale");

		await assert.rejects(
			checkPrebuildFreshness({ builtFile, host: "darwin-arm64", rootDir: tempDir }),
			/error: stale vendored prebuild for darwin-arm64/,
		);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("passes when the engine prebuild matches the rebuilt binary, and --update re-vendors it", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "senpi-desktop-engine-prebuild-fresh-"));
	try {
		const builtFile = join(tempDir, "built");
		const vendored = join(vendoredDir(tempDir, "linux-x64"), "senpi-desktop-engine");
		await writeFile(builtFile, "engine-v2");

		const updated = await checkPrebuildFreshness({ builtFile, host: "linux-x64", rootDir: tempDir, update: true });
		const fresh = await checkPrebuildFreshness({ builtFile, host: "linux-x64", rootDir: tempDir });

		assert.equal(updated.status, "updated");
		assert.equal(await readFile(vendored, "utf8"), "engine-v2");
		assert.equal(fresh.status, "fresh");
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("names the engine binary with .exe only on Windows hosts", () => {
	assert.deepEqual(
		["darwin-arm64", "linux-x64", "win32-x64"].map((host) => getBinaryName(host)),
		["senpi-desktop-engine", "senpi-desktop-engine", "senpi-desktop-engine.exe"],
	);
});
