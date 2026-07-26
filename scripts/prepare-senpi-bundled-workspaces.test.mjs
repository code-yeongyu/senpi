import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	SUPPORTED_NATIVE_PREBUILD_TARGETS,
	assertSenpiPackedWorkspaceFiles,
	bundlablePublishPackageNames,
	bundledWorkspacePackageChecks,
	copyPublishDependencies,
	directNodeModulesPackageName,
	isPlatformConstrainedPackage,
	listStagedPublishPackageNames,
	nativePrebuildFile,
	nativePrebuildTarget,
	stagePublishManifest,
} from "./prepare-senpi-bundled-workspaces.mjs";

let tempDir;

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function writeJson(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, undefined, "\t")}\n`);
}

function writePackage(root, name) {
	const packageDir = join(root, "node_modules", name);
	mkdirSync(packageDir, { recursive: true });
	writeJson(join(packageDir, "package.json"), { name, version: "1.0.0" });
}

function writeShrinkwrap(root, packages) {
	const codingAgentDir = join(root, "packages", "coding-agent");
	mkdirSync(codingAgentDir, { recursive: true });
	writeJson(join(codingAgentDir, "publish-deps.lock.json"), {
		name: "@code-yeongyu/senpi",
		version: "0.0.0",
		lockfileVersion: 3,
		requires: true,
		packages,
	});
}

describe("directNodeModulesPackageName", () => {
	it("extracts only direct package names", () => {
		assert.equal(directNodeModulesPackageName("node_modules/typebox"), "typebox");
		assert.equal(directNodeModulesPackageName("node_modules/@scope/pkg"), "@scope/pkg");
		assert.equal(directNodeModulesPackageName("node_modules/typebox/node_modules/nested"), undefined);
		assert.equal(directNodeModulesPackageName("packages/coding-agent"), undefined);
	});
});

describe("listStagedPublishPackageNames", () => {
	it("lists top-level and scoped packages, skipping dot directories", () => {
		// Given
		tempDir = mkdtempSync(join(tmpdir(), "senpi-staged-names-"));
		const nodeModules = join(tempDir, "node_modules");
		mkdirSync(join(nodeModules, ".bin"), { recursive: true });
		writePackage(tempDir, "typebox");
		writePackage(tempDir, "@scope/pkg");

		// When / Then
		assert.deepEqual(listStagedPublishPackageNames(nodeModules), ["@scope/pkg", "typebox"]);
	});
});

describe("isPlatformConstrainedPackage", () => {
	function writeStagedPackage(root, name, overrides) {
		const packageDir = join(root, "node_modules", name);
		mkdirSync(packageDir, { recursive: true });
		writeJson(join(packageDir, "package.json"), { name, version: "1.0.0", ...overrides });
		return packageDir;
	}

	it("detects os/cpu/libc constraints in both array and bare-string form", () => {
		// Given
		tempDir = mkdtempSync(join(tmpdir(), "senpi-platform-constraint-"));

		// When / Then
		assert.equal(isPlatformConstrainedPackage(writeStagedPackage(tempDir, "portable", {})), false);
		assert.equal(isPlatformConstrainedPackage(writeStagedPackage(tempDir, "os-array", { os: ["linux"] })), true);
		assert.equal(isPlatformConstrainedPackage(writeStagedPackage(tempDir, "os-negated", { os: ["!win32"] })), true);
		assert.equal(isPlatformConstrainedPackage(writeStagedPackage(tempDir, "cpu-string", { cpu: "arm64" })), true);
		assert.equal(isPlatformConstrainedPackage(writeStagedPackage(tempDir, "libc-only", { libc: ["musl"] })), true);
		// An empty constraint list restricts nothing, so it must not disqualify the package.
		assert.equal(isPlatformConstrainedPackage(writeStagedPackage(tempDir, "empty", { os: [], cpu: [] })), false);
	});

	it("leaves an unreadable staged package bundled for the staging and pack gates to report", () => {
		// Given
		tempDir = mkdtempSync(join(tmpdir(), "senpi-platform-unreadable-"));

		// When / Then
		assert.equal(isPlatformConstrainedPackage(join(tempDir, "node_modules", "absent")), false);
	});
});

describe("bundlablePublishPackageNames", () => {
	it("drops only the platform-constrained packages and preserves the staged order", () => {
		// Given
		tempDir = mkdtempSync(join(tmpdir(), "senpi-bundlable-"));
		const nodeModules = join(tempDir, "node_modules");
		writePackage(tempDir, "@scope/native-linux");
		writeJson(join(nodeModules, "@scope/native-linux", "package.json"), {
			name: "@scope/native-linux",
			version: "1.0.0",
			os: ["linux"],
			cpu: ["x64"],
		});
		writePackage(tempDir, "cross-spawn");
		writePackage(tempDir, "typebox");

		// When / Then
		const staged = ["@scope/native-linux", "cross-spawn", "typebox"];
		assert.deepEqual(bundlablePublishPackageNames(nodeModules, staged), ["cross-spawn", "typebox"]);
	});
});

describe("stagePublishManifest", () => {
	function writeCodingAgentManifest(root, overrides = {}) {
		writeJson(join(root, "packages", "coding-agent", "package.json"), {
			name: "@code-yeongyu/senpi",
			version: "2026.7.22",
			dependencies: {
				"@earendil-works/pi-ai": "^2026.7.22",
				"cross-spawn": "7.0.6",
			},
			optionalDependencies: {
				"@mariozechner/clipboard": "0.3.9",
			},
			bundleDependencies: ["@earendil-works/pi-ai"],
			bundledDependencies: ["@earendil-works/pi-ai"],
			...overrides,
		});
	}

	function stagePackage(root, name, overrides = {}) {
		const packageDir = join(root, "packages", "coding-agent", "node_modules", name);
		mkdirSync(packageDir, { recursive: true });
		writeJson(join(packageDir, "package.json"), { name, version: "1.0.0", ...overrides });
	}

	function stageAllRuntimePackages(root) {
		for (const name of ["@earendil-works/pi-ai", "cross-spawn", "@mariozechner/clipboard", "which"]) {
			stagePackage(root, name);
		}
	}

	function readStagedManifest(root) {
		return JSON.parse(readFileSync(join(root, "packages", "coding-agent", "package.json"), "utf8"));
	}

	it("lists every staged runtime dependency and transitive in bundleDependencies", () => {
		// Given: cross-spawn's transitive dep `which` is staged but only reachable via an edge.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-stage-manifest-"));
		writeCodingAgentManifest(tempDir);
		stageAllRuntimePackages(tempDir);

		// When
		const staged = stagePublishManifest(tempDir);

		// Then
		const manifest = readStagedManifest(tempDir);
		const expected = ["@earendil-works/pi-ai", "@mariozechner/clipboard", "cross-spawn", "which"];
		assert.deepEqual(staged, expected);
		assert.deepEqual(manifest.bundleDependencies, expected);
		assert.deepEqual(manifest.bundledDependencies, expected);
	});

	it("keeps vendored import paths bundled while resolving them through owned registry aliases", () => {
		// Given
		tempDir = mkdtempSync(join(tmpdir(), "senpi-stage-edges-"));
		writeCodingAgentManifest(tempDir);
		stageAllRuntimePackages(tempDir);

		// When
		stagePublishManifest(tempDir);

		// Then: npm retains the original dependency key for bundle extraction, while Bun
		// resolves the alias target from the fork-owned scope instead of upstream.
		const manifest = readStagedManifest(tempDir);
		assert.deepEqual(manifest.dependencies, {
			"@earendil-works/pi-ai": "npm:@code-yeongyu/senpi-ai@^2026.7.22",
			"cross-spawn": "7.0.6",
		});
		assert.deepEqual(manifest.optionalDependencies, { "@mariozechner/clipboard": "0.3.9" });
		assert.ok(manifest.bundleDependencies.includes("@earendil-works/pi-ai"));
		for (const spec of [...Object.values(manifest.dependencies), ...Object.values(manifest.optionalDependencies)]) {
			assert.doesNotMatch(spec, /^(file|link|workspace):/);
		}
	});

	it("omits platform-constrained natives from bundleDependencies", () => {
		// Given: the npm-publish job runs on linux-x64, so npm materializes only the linux
		// clipboard binaries into the staged tree.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-stage-platform-"));
		writeCodingAgentManifest(tempDir);
		stageAllRuntimePackages(tempDir);
		stagePackage(tempDir, "@mariozechner/clipboard-linux-x64-gnu", { os: ["linux"], cpu: ["x64"] });
		stagePackage(tempDir, "@mariozechner/clipboard-linux-x64-musl", { os: ["linux"], cpu: ["x64"], libc: ["musl"] });

		// When
		const bundled = stagePublishManifest(tempDir);

		// Then: npm republishes the bundled set as required `dependencies`, so bundling either
		// native would abort every non-linux-x64 install with EBADPLATFORM. Portable packages
		// are still bundled, and the optional edge stays so npm resolves the installing
		// platform's own binary.
		const expected = ["@earendil-works/pi-ai", "@mariozechner/clipboard", "cross-spawn", "which"];
		assert.deepEqual(bundled, expected);
		const manifest = readStagedManifest(tempDir);
		assert.deepEqual(manifest.bundleDependencies, expected);
		assert.deepEqual(manifest.bundledDependencies, expected);
		assert.deepEqual(manifest.optionalDependencies, { "@mariozechner/clipboard": "0.3.9" });
	});

	it("throws when a declared runtime dependency is not staged", () => {
		// Given: cross-spawn is declared but missing from the staged node_modules.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-stage-missing-"));
		writeCodingAgentManifest(tempDir);
		stagePackage(tempDir, "@earendil-works/pi-ai");
		stagePackage(tempDir, "@mariozechner/clipboard");

		// When / Then
		assert.throws(() => stagePublishManifest(tempDir), /missing staged runtime dependencies: cross-spawn/);
	});

	it("throws when a dependency spec uses a local file:/link: protocol", () => {
		// Given
		tempDir = mkdtempSync(join(tmpdir(), "senpi-stage-local-spec-"));
		writeCodingAgentManifest(tempDir, {
			dependencies: { "local-pkg": "file:../local-pkg" },
		});
		stagePackage(tempDir, "local-pkg");
		stagePackage(tempDir, "@mariozechner/clipboard");

		// When / Then
		assert.throws(() => stagePublishManifest(tempDir), /must not reference local paths/);
	});
});

describe("copyPublishDependencies", () => {
	it("copies direct publish dependencies and skips internal workspaces and missing optional packages", () => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-bundle-deps-"));
		writePackage(tempDir, "typebox");
		writePackage(tempDir, "@scope/pkg");
		writePackage(tempDir, "nested-only");
		writeShrinkwrap(tempDir, {
			"": { dependencies: { typebox: "1.0.0" } },
			"node_modules/typebox": { version: "1.0.0" },
			"node_modules/@scope/pkg": { version: "1.0.0" },
			"node_modules/@earendil-works/pi-ai": { version: "1.0.0" },
			"node_modules/missing-optional": { version: "1.0.0", optional: true },
			"node_modules/typebox/node_modules/nested-only": { version: "1.0.0" },
		});

		copyPublishDependencies(tempDir);

		assert.equal(
			JSON.parse(
				readFileSync(join(tempDir, "packages", "coding-agent", "node_modules", "typebox", "package.json"), "utf8"),
			).name,
			"typebox",
		);
		assert.equal(
			JSON.parse(
				readFileSync(join(tempDir, "packages", "coding-agent", "node_modules", "@scope", "pkg", "package.json"), "utf8"),
			).name,
			"@scope/pkg",
		);
		assert.throws(
			() =>
				readFileSync(
					join(tempDir, "packages", "coding-agent", "node_modules", "@earendil-works", "pi-ai", "package.json"),
					"utf8",
				),
			/ENOENT/,
		);
		assert.throws(
			() =>
				readFileSync(
					join(tempDir, "packages", "coding-agent", "node_modules", "missing-optional", "package.json"),
					"utf8",
				),
			/ENOENT/,
		);
		assert.throws(
			() =>
				readFileSync(
					join(tempDir, "packages", "coding-agent", "node_modules", "typebox", "node_modules", "nested-only"),
					"utf8",
				),
			/ENOENT/,
		);
	});

	it("copies transitive dependencies nested inside a staged package directory", () => {
		// Given: nested-dep is not hoisted; it lives inside typebox's own node_modules.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-bundle-transitive-"));
		writePackage(tempDir, "typebox");
		writePackage(join(tempDir, "node_modules", "typebox"), "nested-dep");
		writeShrinkwrap(tempDir, {
			"": { dependencies: { typebox: "1.0.0" } },
			"node_modules/typebox": { version: "1.0.0" },
			"node_modules/typebox/node_modules/nested-dep": { version: "1.0.0" },
		});

		// When
		copyPublishDependencies(tempDir);

		// Then: the transitive dependency rides along with its parent's directory copy.
		assert.equal(
			JSON.parse(
				readFileSync(
					join(tempDir, "packages", "coding-agent", "node_modules", "typebox", "node_modules", "nested-dep", "package.json"),
					"utf8",
				),
			).name,
			"nested-dep",
		);
	});

	it("throws when a required publish dependency is not installed", () => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-bundle-missing-"));
		writeShrinkwrap(tempDir, {
			"": { dependencies: { typebox: "1.0.0" } },
			"node_modules/typebox": { version: "1.0.0" },
		});

		assert.throws(() => copyPublishDependencies(tempDir), /Missing .*node_modules\/typebox/);
	});
});

describe("assertSenpiPackedWorkspaceFiles", () => {
	it("rejects senpi package metadata that omits bundled workspace files", () => {
		// Given
		const packed = {
			files: [{ path: "package/dist/cli.js" }, { path: "package/CHANGELOG.md" }],
		};

		// When / Then
		assert.throws(
			() => assertSenpiPackedWorkspaceFiles(packed),
			/package tarball is missing bundled workspace files: .*@earendil-works\/pi-ai/,
		);
	});

	it("rejects a packed tarball that omits a declared runtime dependency", () => {
		// Given: workspace bundles are present, but the cross-spawn registry dep is not vendored.
		const hostPrebuild = nativePrebuildFile(nativePrebuildTarget());
		const packed = {
			files: [
				{ path: "package/dist/cli.js" },
				{ path: "package/node_modules/@earendil-works/pi-agent-core/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-agent-core/dist/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-ai/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-ai/dist/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-pty/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-pty/dist/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-pty/native/index.js" },
				{ path: `package/node_modules/@earendil-works/pi-pty/${hostPrebuild}` },
				{ path: "package/node_modules/@earendil-works/pi-tui/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-tui/dist/index.js" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/package.json" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/src/index.ts" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/src/kernels/py/prelude.py" },
				{ path: "package/node_modules/which/package.json" },
			],
		};

		// When / Then
		assert.throws(
			() => assertSenpiPackedWorkspaceFiles(packed, { runtimeDependencies: ["cross-spawn", "which"] }),
			/missing vendored runtime dependencies: cross-spawn/,
		);
	});

	it("accepts a packed tarball whose declared runtime dependencies are all vendored", () => {
		// Given
		const hostPrebuild = nativePrebuildFile(nativePrebuildTarget());
		const packed = {
			files: [
				{ path: "package/dist/cli.js" },
				{ path: "package/node_modules/@earendil-works/pi-agent-core/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-agent-core/dist/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-ai/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-ai/dist/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-pty/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-pty/dist/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-pty/native/index.js" },
				{ path: `package/node_modules/@earendil-works/pi-pty/${hostPrebuild}` },
				{ path: "package/node_modules/@earendil-works/pi-tui/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-tui/dist/index.js" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/package.json" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/src/index.ts" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/src/kernels/py/prelude.py" },
				{ path: "package/node_modules/cross-spawn/package.json" },
				{ path: "package/node_modules/@modelcontextprotocol/sdk/package.json" },
			],
		};

		// When / Then
		assert.doesNotThrow(() =>
			assertSenpiPackedWorkspaceFiles(packed, { runtimeDependencies: ["cross-spawn", "@modelcontextprotocol/sdk"] }),
		);
	});

	it("rejects a packed tarball that ships npm-shrinkwrap.json", () => {
		// Given: a shipped npm-shrinkwrap.json is fatal — npm treats it as the complete
		// locked tree and never installs the non-bundled direct deps (cross-spawn, the
		// MCP sdk, ...), so the installed CLI dies with ERR_MODULE_NOT_FOUND.
		const hostPrebuild = nativePrebuildFile(nativePrebuildTarget());
		const packed = {
			files: [
				{ path: "package/dist/cli.js" },
				{ path: "package/npm-shrinkwrap.json" },
				{ path: "package/node_modules/@earendil-works/pi-agent-core/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-agent-core/dist/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-ai/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-ai/dist/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-pty/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-pty/dist/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-pty/native/index.js" },
				{ path: `package/node_modules/@earendil-works/pi-pty/${hostPrebuild}` },
				{ path: "package/node_modules/@earendil-works/pi-tui/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-tui/dist/index.js" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/package.json" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/src/index.ts" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/src/kernels/py/prelude.py" },
			],
		};

		// When / Then
		assert.throws(
			() => assertSenpiPackedWorkspaceFiles(packed),
			/must not ship npm-shrinkwrap\.json/,
		);
	});

	it("accepts senpi package metadata that includes bundled workspace entrypoints", () => {
		// Given
		const hostPrebuild = nativePrebuildFile(nativePrebuildTarget());
		const packed = {
			files: [
				{ path: "package/dist/cli.js" },
				{ path: "package/node_modules/@earendil-works/pi-agent-core/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-agent-core/dist/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-ai/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-ai/dist/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-pty/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-pty/dist/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-pty/native/index.js" },
				{ path: `package/node_modules/@earendil-works/pi-pty/${hostPrebuild}` },
				{ path: "package/node_modules/@earendil-works/pi-tui/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-tui/dist/index.js" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/package.json" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/src/index.ts" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/src/kernels/py/prelude.py" },
			],
		};

		// When / Then
		assert.doesNotThrow(() => assertSenpiPackedWorkspaceFiles(packed));
	});

	it("accepts npm dry-run package metadata with unprefixed paths", () => {
		// Given
		const hostPrebuild = nativePrebuildFile(nativePrebuildTarget());
		const packed = {
			files: [
				{ path: "dist/cli.js" },
				{ path: "node_modules/@earendil-works/pi-agent-core/package.json" },
				{ path: "node_modules/@earendil-works/pi-agent-core/dist/index.js" },
				{ path: "node_modules/@earendil-works/pi-ai/package.json" },
				{ path: "node_modules/@earendil-works/pi-ai/dist/index.js" },
				{ path: "node_modules/@earendil-works/pi-pty/package.json" },
				{ path: "node_modules/@earendil-works/pi-pty/dist/index.js" },
				{ path: "node_modules/@earendil-works/pi-pty/native/index.js" },
				{ path: `node_modules/@earendil-works/pi-pty/${hostPrebuild}` },
				{ path: "node_modules/@earendil-works/pi-tui/package.json" },
				{ path: "node_modules/@earendil-works/pi-tui/dist/index.js" },
				{ path: "node_modules/@code-yeongyu/senpi-codemode/package.json" },
				{ path: "node_modules/@code-yeongyu/senpi-codemode/src/index.ts" },
				{ path: "node_modules/@code-yeongyu/senpi-codemode/src/kernels/py/prelude.py" },
			],
		};

		// When / Then
		assert.doesNotThrow(() => assertSenpiPackedWorkspaceFiles(packed));
	});

	it("rejects senpi package metadata that omits the bundled pty native loader", () => {
		// Given
		const packed = {
			files: [
				{ path: "package/dist/cli.js" },
				{ path: "package/node_modules/@earendil-works/pi-agent-core/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-agent-core/dist/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-ai/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-ai/dist/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-pty/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-pty/dist/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-tui/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-tui/dist/index.js" },
			],
		};

		// When / Then
		assert.throws(
			() => assertSenpiPackedWorkspaceFiles(packed),
			/package tarball is missing bundled workspace files: .*@earendil-works\/pi-pty\/native\/index\.js/,
		);
	});

	it("accepts senpi package metadata that omits the host pty prebuild (pipe fallback)", () => {
		// Given: all loader files present, but no host native prebuild.
		const packed = {
			files: [
				{ path: "package/dist/cli.js" },
				{ path: "package/node_modules/@earendil-works/pi-agent-core/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-agent-core/dist/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-ai/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-ai/dist/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-pty/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-pty/dist/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-pty/native/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-tui/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-tui/dist/index.js" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/package.json" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/src/index.ts" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/src/kernels/py/prelude.py" },
			],
		};

		// When / Then: the native prebuild is optional (pipe fallback), so this must not throw.
		const originalWarn = console.warn;
		console.warn = () => {};
		try {
			assert.doesNotThrow(() => assertSenpiPackedWorkspaceFiles(packed));
		} finally {
			console.warn = originalWarn;
		}
	});

	it("accepts an all-OS check when a target's prebuild is absent (pipe fallback)", () => {
		// Given: the darwin-arm64 prebuild is present but linux-x64 is not.
		const missingTarget = "linux-x64";
		const packed = {
			files: [
				{ path: "package/dist/cli.js" },
				{ path: "package/node_modules/@earendil-works/pi-agent-core/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-agent-core/dist/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-ai/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-ai/dist/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-pty/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-pty/dist/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-pty/native/index.js" },
				{ path: `package/node_modules/@earendil-works/pi-pty/${nativePrebuildFile("darwin-arm64")}` },
				{ path: "package/node_modules/@earendil-works/pi-tui/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-tui/dist/index.js" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/package.json" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/src/index.ts" },
				{ path: "package/node_modules/@code-yeongyu/senpi-codemode/src/kernels/py/prelude.py" },
			],
		};

		// When / Then: a missing per-target prebuild is optional, so the check must not throw.
		assert.ok(SUPPORTED_NATIVE_PREBUILD_TARGETS.includes(missingTarget));
		const originalWarn = console.warn;
		console.warn = () => {};
		try {
			assert.doesNotThrow(() =>
				assertSenpiPackedWorkspaceFiles(packed, { nativePrebuildTargets: ["darwin-arm64", missingTarget] }),
			);
		} finally {
			console.warn = originalWarn;
		}
	});

	it("publishes the supported native target list through package checks", () => {
		// When
		const checks = bundledWorkspacePackageChecks(SUPPORTED_NATIVE_PREBUILD_TARGETS);
		const ptyCheck = checks.find((check) => check.packageName === "@earendil-works/pi-pty");

		// Then
		assert.ok(ptyCheck);
		assert.deepEqual(
			ptyCheck.requiredFiles.filter((file) => file.startsWith("native/prebuilds/")),
			SUPPORTED_NATIVE_PREBUILD_TARGETS.map(nativePrebuildFile),
		);
	});
});
