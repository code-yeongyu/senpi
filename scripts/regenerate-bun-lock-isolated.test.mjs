import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	assertIslandIsClean,
	assertSupportedBunVersion,
	collectWorkspaceManifestPaths,
	createIsland,
	regenerateBunLock,
} from "./regenerate-bun-lock-isolated.mjs";

let tempDir;

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function write(path, content) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function writeJson(path, value) {
	write(path, `${JSON.stringify(value, undefined, "\t")}\n`);
}

/** A miniature npm-owned monorepo: workspaces, npm lockfiles and an installed tree. */
function writeRepoFixture(root) {
	writeJson(join(root, "package.json"), {
		name: "senpi-monorepo",
		private: true,
		workspaces: ["packages/*", "packages/session-backends/*", "packages/coding-agent/examples/extensions/with-deps"],
	});
	writeJson(join(root, "packages", "chord", "package.json"), { name: "@earendil-works/chord", version: "2026.9.12" });
	writeJson(join(root, "packages", "ai", "package.json"), { name: "@earendil-works/pi-ai", version: "2026.9.12" });
	writeJson(join(root, "packages", "coding-agent", "package.json"), { name: "@code-yeongyu/senpi", version: "2026.9.12" });
	writeJson(join(root, "packages", "session-backends", "sqlite-node", "package.json"), {
		name: "@earendil-works/pi-storage-sqlite-node",
		version: "0.83.0",
	});
	writeJson(join(root, "packages", "coding-agent", "examples", "extensions", "with-deps", "package.json"), {
		name: "pi-extension-with-deps",
		version: "0.82.0",
	});
	// npm-owned artifacts that Bun must never see.
	writeJson(join(root, "package-lock.json"), { name: "senpi-monorepo", lockfileVersion: 3, packages: {} });
	writeJson(join(root, "packages", "ai", "package-lock.json"), { name: "@earendil-works/pi-ai", lockfileVersion: 3 });
	writeJson(join(root, "node_modules", "typebox", "package.json"), { name: "typebox", version: "1.3.27" });
	writeJson(join(root, "packages", "ai", "node_modules", "openai", "package.json"), { name: "openai", version: "6.26.0" });
	write(join(root, "bun.lock"), '{"lockfileVersion": 1, "workspaces": {}}\n');
	return root;
}

describe("collectWorkspaceManifestPaths", () => {
	it("collects the root manifest plus every workspace manifest at its repository-relative path", () => {
		// Given
		tempDir = mkdtempSync(join(tmpdir(), "bun-lock-collect-"));
		writeRepoFixture(tempDir);

		// When
		const manifestPaths = collectWorkspaceManifestPaths(tempDir);

		// Then
		assert.deepEqual(manifestPaths, [
			"package.json",
			"packages/ai/package.json",
			"packages/chord/package.json",
			"packages/coding-agent/package.json",
			"packages/session-backends/sqlite-node/package.json",
			"packages/coding-agent/examples/extensions/with-deps/package.json",
		]);
	});

	it("reflects the real repository workspace graph", () => {
		// When
		const manifestPaths = collectWorkspaceManifestPaths();

		// Then
		assert.ok(manifestPaths.includes("package.json"));
		assert.ok(manifestPaths.includes("packages/chord/package.json"));
		assert.ok(manifestPaths.includes("packages/coding-agent/package.json"));
		assert.ok(manifestPaths.includes("packages/session-backends/sqlite-node/package.json"));
		assert.equal(
			manifestPaths.some((manifestPath) => manifestPath.includes("node_modules")),
			false,
		);
	});
});

describe("createIsland", () => {
	it("copies only manifests and bun.lock, never npm lockfiles or node_modules", () => {
		// Given
		tempDir = mkdtempSync(join(tmpdir(), "bun-lock-island-"));
		const repoRoot = join(tempDir, "repo");
		const islandRoot = join(tempDir, "island");
		writeRepoFixture(repoRoot);

		// When
		createIsland(repoRoot, collectWorkspaceManifestPaths(repoRoot), islandRoot);

		// Then
		assert.equal(
			JSON.parse(readFileSync(join(islandRoot, "packages/ai/package.json"), "utf8")).name,
			"@earendil-works/pi-ai",
		);
		assert.equal(readFileSync(join(islandRoot, "bun.lock"), "utf8"), '{"lockfileVersion": 1, "workspaces": {}}\n');
		assert.equal(existsSync(join(islandRoot, "package-lock.json")), false);
		assert.equal(existsSync(join(islandRoot, "packages/ai/package-lock.json")), false);
		assert.equal(existsSync(join(islandRoot, "node_modules")), false);
		assert.equal(existsSync(join(islandRoot, "packages/ai/node_modules")), false);
	});
});

describe("assertIslandIsClean", () => {
	it("refuses an island that contains a package-lock.json", () => {
		// Given
		tempDir = mkdtempSync(join(tmpdir(), "bun-lock-dirty-"));
		writeJson(join(tempDir, "package.json"), { name: "senpi-monorepo", private: true });
		writeJson(join(tempDir, "package-lock.json"), { name: "senpi-monorepo", lockfileVersion: 3 });

		// When / Then
		assert.throws(() => assertIslandIsClean(tempDir), /contaminated by npm-owned artifacts: package-lock\.json/);
	});

	it("refuses an island that contains a nested node_modules or npm-shrinkwrap.json", () => {
		// Given
		tempDir = mkdtempSync(join(tmpdir(), "bun-lock-dirty-nested-"));
		writeJson(join(tempDir, "package.json"), { name: "senpi-monorepo", private: true });
		writeJson(join(tempDir, "packages", "ai", "package.json"), { name: "@earendil-works/pi-ai" });
		writeJson(join(tempDir, "packages", "ai", "node_modules", "openai", "package.json"), { name: "openai" });
		writeJson(join(tempDir, "packages", "coding-agent", "npm-shrinkwrap.json"), { lockfileVersion: 3 });

		// When / Then
		assert.throws(
			() => assertIslandIsClean(tempDir),
			/packages\/ai\/node_modules.*packages\/coding-agent\/npm-shrinkwrap\.json/s,
		);
	});
});

describe("assertSupportedBunVersion", () => {
	it("accepts bun 1.4.x and rejects every other line", () => {
		assert.equal(assertSupportedBunVersion("1.4.2\n"), true);
		assert.throws(() => assertSupportedBunVersion("1.3.9"), /bun 1\.4\.x is required/);
		assert.throws(() => assertSupportedBunVersion(""), /found <unknown>/);
	});
});

describe("regenerateBunLock", () => {
	it("copies back only bun.lock and leaves every npm-owned file untouched", () => {
		// Given
		tempDir = mkdtempSync(join(tmpdir(), "bun-lock-regen-"));
		const repoRoot = join(tempDir, "repo");
		writeRepoFixture(repoRoot);
		const rootLockBefore = readFileSync(join(repoRoot, "package-lock.json"), "utf8");
		let islandSeen;

		// When: a fake Bun resolves in the island and writes a new lockfile there.
		const result = regenerateBunLock({
			repoRoot,
			islandParent: tempDir,
			runBun: (islandRoot) => {
				islandSeen = islandRoot;
				writeFileSync(join(islandRoot, "bun.lock"), '{"lockfileVersion": 1, "workspaces": {"": {}}}\n');
				return "1.4.2";
			},
		});

		// Then
		assert.equal(result.changed, true);
		assert.equal(result.bunVersion, "1.4.2");
		assert.equal(readFileSync(join(repoRoot, "bun.lock"), "utf8"), '{"lockfileVersion": 1, "workspaces": {"": {}}}\n');
		assert.equal(readFileSync(join(repoRoot, "package-lock.json"), "utf8"), rootLockBefore);
		assert.equal(existsSync(join(repoRoot, "node_modules", "typebox", "package.json")), true);
		assert.equal(existsSync(islandSeen), false);
	});

	it("leaves bun.lock alone in --check mode and reports whether it would change", () => {
		// Given
		tempDir = mkdtempSync(join(tmpdir(), "bun-lock-check-"));
		const repoRoot = join(tempDir, "repo");
		writeRepoFixture(repoRoot);
		const before = readFileSync(join(repoRoot, "bun.lock"), "utf8");

		// When
		const drifted = regenerateBunLock({
			repoRoot,
			islandParent: tempDir,
			check: true,
			runBun: (islandRoot) => {
				writeFileSync(join(islandRoot, "bun.lock"), '{"lockfileVersion": 1, "workspaces": {"": {}}}\n');
				return "1.4.2";
			},
		});
		const stable = regenerateBunLock({
			repoRoot,
			islandParent: tempDir,
			check: true,
			runBun: () => "1.4.2",
		});

		// Then
		assert.equal(drifted.changed, true);
		assert.equal(stable.changed, false);
		assert.equal(readFileSync(join(repoRoot, "bun.lock"), "utf8"), before);
	});

	it("fails when the resolver rewrites a workspace manifest instead of only the lockfile", () => {
		// Given
		tempDir = mkdtempSync(join(tmpdir(), "bun-lock-mutation-"));
		const repoRoot = join(tempDir, "repo");
		writeRepoFixture(repoRoot);

		// When / Then
		assert.throws(
			() =>
				regenerateBunLock({
					repoRoot,
					islandParent: tempDir,
					runBun: (islandRoot) => {
						writeJson(join(islandRoot, "packages", "ai", "package.json"), {
							name: "@earendil-works/pi-ai",
							version: "2026.9.12",
							trustedDependencies: ["esbuild"],
						});
						writeFileSync(join(islandRoot, "bun.lock"), "{}\n");
						return "1.4.2";
					},
				}),
			/bun rewrote workspace manifests in the island: packages\/ai\/package\.json/,
		);
		assert.equal(readFileSync(join(repoRoot, "bun.lock"), "utf8"), '{"lockfileVersion": 1, "workspaces": {}}\n');
	});

	it("fails when the resolver produces no lockfile", () => {
		// Given
		tempDir = mkdtempSync(join(tmpdir(), "bun-lock-missing-"));
		const repoRoot = join(tempDir, "repo");
		writeRepoFixture(repoRoot);

		// When / Then
		assert.throws(
			() =>
				regenerateBunLock({
					repoRoot,
					islandParent: tempDir,
					runBun: (islandRoot) => {
						rmSync(join(islandRoot, "bun.lock"));
						return "1.4.2";
					},
				}),
			/produced no bun\.lock in the island/,
		);
	});

	it("refuses to resolve when an npm lockfile reaches the island", () => {
		// Given: a contaminating writer drops a package-lock.json into the island.
		tempDir = mkdtempSync(join(tmpdir(), "bun-lock-contaminated-"));
		const repoRoot = join(tempDir, "repo");
		writeRepoFixture(repoRoot);

		// When / Then
		assert.throws(
			() =>
				regenerateBunLock({
					repoRoot,
					islandParent: tempDir,
					runBun: (islandRoot) => {
						writeJson(join(islandRoot, "package-lock.json"), { lockfileVersion: 3 });
						writeFileSync(join(islandRoot, "bun.lock"), "{}\n");
						return "1.4.2";
					},
				}),
			/contaminated by npm-owned artifacts: package-lock\.json/,
		);
	});
});
