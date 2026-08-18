import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
			files: ["dist", "README.md"],
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
			"@earendil-works/pi-ai": "npm:@code-yeongyu/senpi-ai@2026.7.22",
			"cross-spawn": "7.0.6",
			which: "1.0.0",
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

	it("issue 446 promotes a bundled package's platform optional dependencies to the consumer manifest", () => {
		// Given: the Linux publisher materializes only its own Claude sidecar, while the
		// bundled SDK declares the complete cross-platform optional dependency family.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-stage-claude-sidecars-"));
		const platformPackages = {
			"@anthropic-ai/claude-agent-sdk-darwin-arm64": "0.3.220",
			"@anthropic-ai/claude-agent-sdk-darwin-x64": "0.3.220",
			"@anthropic-ai/claude-agent-sdk-linux-arm64": "0.3.220",
			"@anthropic-ai/claude-agent-sdk-linux-arm64-musl": "0.3.220",
			"@anthropic-ai/claude-agent-sdk-linux-x64": "0.3.220",
			"@anthropic-ai/claude-agent-sdk-linux-x64-musl": "0.3.220",
			"@anthropic-ai/claude-agent-sdk-win32-arm64": "0.3.220",
			"@anthropic-ai/claude-agent-sdk-win32-x64": "0.3.220",
		};
		writeCodingAgentManifest(tempDir, {
			dependencies: { "@anthropic-ai/claude-agent-sdk": "0.3.220" },
			optionalDependencies: {},
		});
		stagePackage(tempDir, "@anthropic-ai/claude-agent-sdk", {
			version: "0.3.220",
			optionalDependencies: platformPackages,
		});
		stagePackage(tempDir, "@anthropic-ai/claude-agent-sdk-linux-x64", {
			version: "0.3.220",
			os: ["linux"],
			cpu: ["x64"],
			libc: ["glibc"],
		});

		// When
		stagePublishManifest(tempDir);

		// Then: npm installs the matching sidecar on the consumer instead of preserving
		// the publisher's Linux-only binary inside the universal Senpi tarball.
		const manifest = readStagedManifest(tempDir);
		const stagedSdkManifest = JSON.parse(
			readFileSync(join(tempDir, "packages", "coding-agent", "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"), "utf8"),
		);
		assert.deepEqual(manifest.optionalDependencies, platformPackages);
		assert.deepEqual(stagedSdkManifest.optionalDependencies, {});
		assert.ok(manifest.bundleDependencies.includes("@anthropic-ai/claude-agent-sdk"));
		assert.ok(!manifest.bundleDependencies.includes("@anthropic-ai/claude-agent-sdk-linux-x64"));
		const packed = JSON.parse(
			execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
				cwd: join(tempDir, "packages", "coding-agent"),
				encoding: "utf8",
			}),
		)[0];
		assert.ok(!(packed.files ?? []).some(({ path }) => path.includes("claude-agent-sdk-linux-x64")));
	});

	it("keeps an unreadable staged package for the later pack validation gate", () => {
		// Given: the existing contract leaves unreadable package metadata bundled so the
		// dedicated staging and pack gates can report it instead of silently dropping it.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-stage-unreadable-"));
		writeCodingAgentManifest(tempDir, {
			dependencies: { "unreadable-package": "1.0.0" },
			optionalDependencies: {},
		});
		const packageDir = join(tempDir, "packages", "coding-agent", "node_modules", "unreadable-package");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(join(packageDir, "package.json"), "{");

		// When / Then
		assert.deepEqual(stagePublishManifest(tempDir), ["unreadable-package"]);
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
