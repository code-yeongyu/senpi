import { afterAll, beforeAll, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compiledExtensionPlatform } from "./compiled-extension-platform.ts";
import { registerCompiledProviderCases } from "./compiled-provider-probe-cases.ts";

const repo = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "senpi-compiled-provider-"));
const platform = compiledExtensionPlatform(process.platform, process.arch);
const release = join(scratch, "release");
const relocated = join(scratch, "relocated");

beforeAll(() => {
	const build = spawnSync("bash", ["scripts/build-binaries.sh", "--skip-install", "--skip-build", "--platform", platform.target, "--out", release], {
		cwd: repo, encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024,
	});
	expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
	renameSync(join(release, platform.target), relocated);
}, 310_000);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

registerCompiledProviderCases(join(relocated, platform.executable), scratch, [0, 1, 2]);
