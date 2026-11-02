import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertPublishedWorkspacePackFiles, assertSenpiPackedWorkspaceFiles, nativePrebuildFile } from "./senpi-publish-pack-checks.mjs";

const VENDORED_FILES = [
	"vendor/pi-client/index.js",
	"vendor/pi-client/index.d.ts",
	"vendor/pi-protocol/index.js",
	"vendor/pi-protocol/index.d.ts",
];

function packedFiles(extraPaths = [], prefix = "package/") {
	return {
		files: ["package.json", "dist/cli.js", "dist/bundle/cli.js", ...VENDORED_FILES, ...extraPaths].map((path) => ({
			path: `${prefix}${path}`,
		})),
	};
}

function stagedManifest(overrides = {}) {
	return {
		name: "@code-yeongyu/senpi",
		version: "2026.7.22",
		dependencies: {
			"@code-yeongyu/senpi-codemode": "2026.7.22",
			"@earendil-works/chord": "0.85.1",
			"@earendil-works/pi-agent-core": "npm:@code-yeongyu/senpi-agent-core@2026.7.22",
			"@earendil-works/pi-ai": "npm:@code-yeongyu/senpi-ai@2026.7.22",
			"@earendil-works/pi-pty": "npm:@code-yeongyu/senpi-pty@2026.7.22",
			"@earendil-works/pi-tui": "npm:@code-yeongyu/senpi-tui@2026.7.22",
			"cross-spawn": "7.0.6",
		},
		optionalDependencies: { "@mariozechner/clipboard": "0.3.9" },
		...overrides,
	};
}

describe("assertSenpiPackedWorkspaceFiles", () => {
	it("accepts a registry-resolved tarball with the vendored client and protocol", () => {
		assert.doesNotThrow(() => assertSenpiPackedWorkspaceFiles(packedFiles(), stagedManifest()));
	});

	it("accepts npm dry-run package metadata with unprefixed paths", () => {
		assert.doesNotThrow(() => assertSenpiPackedWorkspaceFiles(packedFiles([], ""), stagedManifest()));
	});

	for (const path of [
		"node_modules/cross-spawn/package.json",
		"node_modules/@earendil-works/pi-client/package.json",
		"dist/vendored/node_modules/which/package.json",
	]) {
		it(`rejects a tarball that ships ${path}`, () => {
			// Given: every runtime dependency is a registry edge, so any shipped dependency
			// tree duplicates it (bun keeps both) or exposes client/protocol to the resolver.
			const packed = packedFiles([path]);

			// When / Then
			assert.throws(
				() => assertSenpiPackedWorkspaceFiles(packed, stagedManifest()),
				new RegExp(`must not ship node_modules \\(found ${path.replaceAll(".", "\\.")}\\)`),
			);
		});
	}

	for (const path of ["dist/index.js.map", "dist/index.d.ts.map", "vendor/pi-client/index.js.map"]) {
		it(`rejects a tarball that ships the sourcemap ${path} (senpi#2362)`, () => {
			// Given: published maps point at workspace sources that are never published.
			const packed = packedFiles([path]);

			// When / Then
			assert.throws(
				() => assertSenpiPackedWorkspaceFiles(packed, stagedManifest()),
				new RegExp(`senpi package tarball must not ship sourcemaps \\(found 1, e\\.g\\. ${path.replaceAll(".", "\\.")}\\)`),
			);
		});
	}

	it("rejects a packed tarball that ships npm-shrinkwrap.json", () => {
		// Given: a shipped shrinkwrap overrides consumer resolution of the whole tree.
		const packed = packedFiles(["npm-shrinkwrap.json"]);

		// When / Then
		assert.throws(() => assertSenpiPackedWorkspaceFiles(packed, stagedManifest()), /must not ship npm-shrinkwrap\.json/);
	});

	for (const field of ["bundleDependencies", "bundledDependencies"]) {
		it(`rejects a staged manifest that still declares ${field}`, () => {
			// Given
			const manifest = stagedManifest({ [field]: ["cross-spawn"] });

			// When / Then
			assert.throws(
				() => assertSenpiPackedWorkspaceFiles(packedFiles(), manifest),
				/must not declare bundleDependencies/,
			);
		});
	}

	it("rejects a manifest that declares a never-published fork package (senpi#2141)", () => {
		// Given
		const manifest = stagedManifest({
			optionalDependencies: { "@code-yeongyu/senpi-never-published": "2026.7.22" },
		});

		// When / Then
		assert.throws(
			() => assertSenpiPackedWorkspaceFiles(packedFiles(), manifest),
			/declares packages that are never published.*@code-yeongyu\/senpi-never-published/,
		);
	});

	for (const [label, spec] of [
		["a plain version", "2026.7.22"],
		["an alias to the upstream name", "npm:@earendil-works/pi-ai@2026.7.22"],
	]) {
		it(`rejects a fork dependency declared through ${label}`, () => {
			// Given: the upstream name is private and never published by the fork.
			const manifest = stagedManifest();
			manifest.dependencies["@earendil-works/pi-ai"] = spec;

			// When / Then
			assert.throws(
				() => assertSenpiPackedWorkspaceFiles(packedFiles(), manifest),
				new RegExp(`through their published aliases: @earendil-works/pi-ai=${spec.replaceAll(".", "\\.")}`),
			);
		});
	}

	it("rejects a tarball missing a vendored client or protocol file", () => {
		// Given
		const packed = packedFiles();
		packed.files = packed.files.filter(({ path }) => path !== "package/vendor/pi-protocol/index.d.ts");

		// When / Then
		assert.throws(
			() => assertSenpiPackedWorkspaceFiles(packed, stagedManifest()),
			/missing vendored workspace files: vendor\/pi-protocol\/index\.d\.ts$/,
		);
	});
});

const REQUIRED_NATIVE_PREBUILD_TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"];
const PTY = "@earendil-works/pi-pty";
const PTY_LOADER_FILES = ["package.json", "dist/index.js", "native/index.js"];

describe("assertPublishedWorkspacePackFiles required native prebuilds (senpi#1193)", () => {
	it("rejects a senpi-pty tarball missing a required release-built prebuild (senpi#1193)", () => {
		// Given: the pty loader files are packed, but the Linux x64 release artifact is
		// absent — the tarball a Linux user would install would silently pipe-fallback.
		const packed = {
			files: [...PTY_LOADER_FILES, nativePrebuildFile("darwin-arm64", PTY)].map((path) => ({ path: `package/${path}` })),
		};

		// When / Then
		assert.throws(
			() => assertPublishedWorkspacePackFiles(packed, PTY, { requiredNativePrebuildTargets: ["linux-x64"] }),
			/native\/prebuilds\/linux-x64\/senpi_pty\.linux-x64\.node/,
		);
	});

	it("rejects when any one of the five required targets is missing", () => {
		// Given: four of the five publish-only targets are staged; win32-x64 is not.
		const present = REQUIRED_NATIVE_PREBUILD_TARGETS.filter((target) => target !== "win32-x64");
		const packed = {
			files: [...PTY_LOADER_FILES, ...present.map((target) => nativePrebuildFile(target, PTY))].map((path) => ({ path })),
		};

		// When / Then
		assert.throws(
			() => assertPublishedWorkspacePackFiles(packed, PTY, { requiredNativePrebuildTargets: REQUIRED_NATIVE_PREBUILD_TARGETS }),
			/native\/prebuilds\/win32-x64\/senpi_pty\.win32-x64\.node/,
		);
	});

	it("accepts a senpi-pty tarball carrying every required target's prebuild", () => {
		// Given
		const packed = {
			files: [...PTY_LOADER_FILES, ...REQUIRED_NATIVE_PREBUILD_TARGETS.map((target) => nativePrebuildFile(target, PTY))].map(
				(path) => ({ path }),
			),
		};

		// When / Then
		assert.doesNotThrow(() =>
			assertPublishedWorkspacePackFiles(packed, PTY, { requiredNativePrebuildTargets: REQUIRED_NATIVE_PREBUILD_TARGETS }),
		);
	});

	it("keeps an unrequired target warn-only so best-effort rows never fail the pack", () => {
		// Given: win32-arm64 stays best-effort, so its absence must warn, not throw.
		const warnings = [];
		const originalWarn = console.warn;
		console.warn = (message) => warnings.push(String(message));
		try {
			const packed = { files: PTY_LOADER_FILES.map((path) => ({ path: `package/${path}` })) };

			// When / Then
			assert.doesNotThrow(() => assertPublishedWorkspacePackFiles(packed, PTY, { requiredNativePrebuildTargets: [] }));
			assert.equal(warnings.length, 1);
			assert.match(warnings[0], /no native prebuild/);
		} finally {
			console.warn = originalWarn;
		}
	});

	it("rejects an unsupported required target before packing anything", () => {
		assert.throws(
			() =>
				assertPublishedWorkspacePackFiles(
					{ files: PTY_LOADER_FILES.map((path) => ({ path })) },
					PTY,
					{ requiredNativePrebuildTargets: ["freebsd-x64"] },
				),
			/Unsupported native prebuild target: freebsd-x64/,
		);
	});
});
