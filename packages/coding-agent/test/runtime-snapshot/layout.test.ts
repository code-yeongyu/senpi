import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { prepareRuntimeSnapshot } from "../../src/runtime-snapshot/enter.ts";
import { createFakeInstall, type FakeInstall, isInside } from "./fake-install.ts";

// #2408: a snapshot must not resolve anything through the install, because an upgrade that
// changes the package layout (bundledDependencies on or off) deletes the directories it named.
async function handOff(install: FakeInstall): Promise<{ snapshotDir: string; entryPath: string }> {
	const decision = await prepareRuntimeSnapshot(install.entryPath, install.packageDir, install.agentDir);
	if (decision.kind !== "hand-off") throw new Error(`expected a hand-off, got ${decision.kind}`);
	return { snapshotDir: decision.snapshotDir, entryPath: fileURLToPath(decision.entryUrl) };
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
}

describe("self-contained runtime snapshot (#2408)", () => {
	const installs: FakeInstall[] = [];
	afterEach(() => {
		while (installs.length) installs.pop()?.cleanup();
	});

	it("keeps resolving its externals after the install switches from nested to hoisted dependencies", async () => {
		// Given: a session started on a release that nests its dependencies
		const install = createFakeInstall("build-a", "nested");
		installs.push(install);
		const { snapshotDir, entryPath } = await handOff(install);
		// When: the next release installs them hoisted, deleting the nested directory
		install.reinstall("build-b", "hoisted");
		// Then
		const fromSnapshot = createRequire(entryPath);
		for (const name of ["native-ext", "native-helper", "nested-dep", "hoisted-ext"]) {
			const manifest = fromSnapshot.resolve(`${name}/package.json`);
			expect(isInside(manifest, snapshotDir)).toBe(true);
			expect(JSON.parse(readFileSync(manifest, "utf8")).version).toBe("build-a");
		}
		const helperFromExt = createRequire(fromSnapshot.resolve("native-ext/package.json")).resolve("native-helper");
		expect(fromSnapshot(helperFromExt)).toBe("native-helper@build-a");
	});

	it("keeps resolving its externals after the install switches from hoisted to nested dependencies", async () => {
		// Given
		const install = createFakeInstall("build-a", "hoisted");
		installs.push(install);
		const { snapshotDir, entryPath } = await handOff(install);
		// When
		install.reinstall("build-b", "nested");
		// Then
		const manifest = createRequire(entryPath).resolve("native-ext/package.json");
		expect(isInside(manifest, snapshotDir)).toBe(true);
		expect(JSON.parse(readFileSync(manifest, "utf8")).version).toBe("build-a");
	});

	it("serves runtime-read assets from inside the snapshot: a skill, a wasm grammar, a native binary", async () => {
		// Given
		const install = createFakeInstall("build-a");
		installs.push(install);
		const { snapshotDir, entryPath } = await handOff(install);
		install.reinstall("build-b", "hoisted");
		// When
		const skillDir = dirname(createRequire(entryPath).resolve("skill-pkg/package.json"));
		const nativeDir = dirname(createRequire(entryPath).resolve("native-ext/package.json"));
		const assets = [
			join(skillDir, "src/skill/demo/SKILL.md"),
			join(dirname(entryPath), "grammar-X1.wasm"),
			join(nativeDir, "prebuilds/native.node"),
		];
		// Then
		for (const asset of assets) {
			expect(isInside(asset, snapshotDir)).toBe(true);
			expect(lstatSync(asset).isSymbolicLink()).toBe(false);
			expect(readFileSync(asset, "utf8")).toContain("build-a");
		}
		expect(existsSync(join(nativeDir, "index.d.ts"))).toBe(false);
	});

	it("gives a hoisted package the version it resolves in the install when the package nests another", async () => {
		// Given: the package nests conflict@2, a hoisted dependency needs the hoisted conflict@1
		const install = createFakeInstall("build-a", "nested");
		installs.push(install);
		const globalModules = join(install.root, "global/node_modules");
		writeJson(join(globalModules, "conflict/package.json"), { name: "conflict", version: "1.0.0" });
		writeJson(join(install.packageDir, "node_modules/conflict/package.json"), { name: "conflict", version: "2.0.0" });
		writeJson(join(globalModules, "hoisted-ext/package.json"), {
			name: "hoisted-ext",
			version: "build-a",
			dependencies: { conflict: "1" },
		});
		const packageJson = JSON.parse(readFileSync(join(install.packageDir, "package.json"), "utf8"));
		packageJson.dependencies.conflict = "2";
		writeJson(join(install.packageDir, "package.json"), packageJson);
		// When
		const { entryPath } = await handOff(install);
		// Then
		const fromSnapshot = createRequire(entryPath);
		const fromHoisted = createRequire(fromSnapshot.resolve("hoisted-ext/package.json"));
		expect(fromSnapshot("conflict/package.json").version).toBe("2.0.0");
		expect(fromHoisted("conflict/package.json").version).toBe("1.0.0");
	});

	it("publishes a snapshot only once it is complete and removes a crashed build's leftovers", async () => {
		// Given: the only trace of an earlier build of this snapshot is the staging directory of a
		// builder that died half-way, under a pid that no longer exists
		const install = createFakeInstall("build-a");
		installs.push(install);
		const { snapshotDir } = await handOff(install);
		const root = join(install.agentDir, "runtime");
		rmSync(snapshotDir, { recursive: true, force: true });
		mkdirSync(join(root, `.tmp-${basename(snapshotDir)}-999999/node_modules`), { recursive: true });
		// When
		const rebuilt = await handOff(install);
		// Then
		expect(rebuilt.snapshotDir).toBe(snapshotDir);
		expect(readdirSync(root).filter((name) => name.startsWith("."))).toEqual([]);
		expect(existsSync(join(snapshotDir, "runtime-snapshot.json"))).toBe(true);
		expect(existsSync(join(snapshotDir, "node_modules/native-ext/prebuilds/native.node"))).toBe(true);
	});
});
