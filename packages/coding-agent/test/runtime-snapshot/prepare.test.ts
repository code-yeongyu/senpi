import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getInstallPackageDir } from "../../src/config.ts";
import { canonicalizeGlobalDefaultExtensionModulePath } from "../../src/core/resource-loader.ts";
import { prepareRuntimeSnapshot } from "../../src/runtime-snapshot/enter.ts";
import { resolveInstallPath } from "../../src/runtime-snapshot/marker.ts";
import { createFakeInstall, type FakeInstall, isInside } from "./fake-install.ts";

// #2358: a package manager deletes and rewrites the install under running sessions; a launch
// runs from a per-build snapshot instead, so later lazy imports never reach the rewritten tree.
const SHIM_TARGET = "dist/core/extensions/builtin/websearch.js";

async function handOff(install: FakeInstall): Promise<{ snapshotDir: string; entryPath: string }> {
	const decision = await prepareRuntimeSnapshot(install.entryPath, install.packageDir, install.agentDir);
	if (decision.kind !== "hand-off") throw new Error(`expected a hand-off, got ${decision.kind}`);
	return { snapshotDir: decision.snapshotDir, entryPath: fileURLToPath(decision.entryUrl) };
}

describe("runtime snapshot of a bundled install (#2358)", () => {
	const installs: FakeInstall[] = [];
	afterEach(() => {
		while (installs.length) installs.pop()?.cleanup();
	});

	it("keeps the launched build loadable after the install is replaced by another build", async () => {
		// Given
		const install = createFakeInstall("build-a");
		installs.push(install);
		const { snapshotDir, entryPath } = await handOff(install);
		// When
		install.reinstall("build-b");
		// Then
		expect(entryPath).toBe(join(snapshotDir, "dist/bundle/cli.js"));
		expect(readFileSync(join(snapshotDir, "dist/bundle/chunks/provider-build-a.js"), "utf8")).toContain("build-a");
		expect(lstatSync(join(snapshotDir, "dist/bundle/chunks/provider-build-a.js")).isSymbolicLink()).toBe(false);
		expect(JSON.parse(readFileSync(join(snapshotDir, "package.json"), "utf8")).version).toBe("build-a");
	});

	it("resolves nested and hoisted dependencies to its own copies of the install's packages", async () => {
		// Given
		const install = createFakeInstall();
		installs.push(install);
		// When
		const { snapshotDir, entryPath } = await handOff(install);
		// Then
		const fromSnapshot = createRequire(entryPath);
		const fromInstall = createRequire(install.entryPath);
		for (const name of ["nested-dep", "hoisted-ext"]) {
			const resolved = fromSnapshot.resolve(`${name}/package.json`);
			expect(isInside(resolved, snapshotDir)).toBe(true);
			expect(readFileSync(resolved, "utf8")).toBe(readFileSync(fromInstall.resolve(`${name}/package.json`), "utf8"));
		}
		expect(existsSync(join(entryPath, "../../modes/interactive/theme/dark.json"))).toBe(true);
	});

	it("reuses one snapshot per build and claims it from inside without copying again", async () => {
		// Given
		const install = createFakeInstall();
		installs.push(install);
		const first = await handOff(install);
		const copiedAt = statSync(join(first.snapshotDir, "dist/bundle/cli.js")).mtimeMs;
		// When
		const second = await handOff(install);
		const inside = await prepareRuntimeSnapshot(second.entryPath, second.snapshotDir, install.agentDir);
		// Then
		expect(second.snapshotDir).toBe(first.snapshotDir);
		expect(statSync(join(second.snapshotDir, "dist/bundle/cli.js")).mtimeMs).toBe(copiedAt);
		expect(inside).toEqual({ kind: "run-here" });
		expect(readdirSync(join(first.snapshotDir, "claims"))).toEqual([String(process.pid)]);
		expect(readdirSync(join(install.agentDir, "runtime")).filter((name) => name.startsWith("."))).toEqual([]);
	});

	it("runs in place when the bundle ships no runtime manifest", async () => {
		// Given
		const install = createFakeInstall();
		installs.push(install);
		rmSync(join(install.packageDir, "dist/bundle/runtime-manifest.json"));
		// When / Then
		expect(await prepareRuntimeSnapshot(install.entryPath, install.packageDir, install.agentDir)).toEqual({
			kind: "run-here",
		});
	});

	it("reports the real install directory to install-aware callers running from a snapshot", async () => {
		// Given
		const install = createFakeInstall();
		installs.push(install);
		const { snapshotDir } = await handOff(install);
		// When
		process.env.SENPI_PACKAGE_DIR = snapshotDir;
		try {
			// Then
			expect(getInstallPackageDir()).toBe(realpathSync(install.packageDir));
			expect(resolveInstallPath(join(snapshotDir, "dist/bundle/chunks"), snapshotDir)).toBe(
				join(realpathSync(install.packageDir), "dist/bundle/chunks"),
			);
			expect(resolveInstallPath(install.root, snapshotDir)).toBe(install.root);
			expect(canonicalizeGlobalDefaultExtensionModulePath(join(snapshotDir, SHIM_TARGET))).toBe(
				realpathSync(join(install.packageDir, SHIM_TARGET)),
			);
		} finally {
			delete process.env.SENPI_PACKAGE_DIR;
		}
	});
});
