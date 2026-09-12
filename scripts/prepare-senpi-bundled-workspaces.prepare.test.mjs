import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	nativePrebuildFile,
	nativePrebuildTarget,
	prepareSenpiBundledWorkspaces,
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

function writeShrinkwrap(root, packages) {
	writeJson(join(root, "packages", "coding-agent", "publish-deps.lock.json"), {
		name: "@code-yeongyu/senpi",
		version: "0.0.0",
		lockfileVersion: 3,
		requires: true,
		packages,
	});
}

const BUNDLED_WORKSPACE_NAMES = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-pty",
	"@earendil-works/pi-telemetry",
	"@earendil-works/pi-tui",
	"@code-yeongyu/senpi-codemode",
];
const VENDORED_WORKSPACE_NAMES = ["@earendil-works/pi-client", "@earendil-works/pi-protocol"];
const ALL_WORKSPACE_NAMES = [...BUNDLED_WORKSPACE_NAMES, ...VENDORED_WORKSPACE_NAMES];

const BUNDLED_WORKSPACE_PACKAGE_NAMES = new Map([
	["agent", "@earendil-works/pi-agent-core"],
	["ai", "@earendil-works/pi-ai"],
	["client", "@earendil-works/pi-client"],
	["protocol", "@earendil-works/pi-protocol"],
	["pty", "@earendil-works/pi-pty"],
	["telemetry", "@earendil-works/pi-telemetry"],
	["tui", "@earendil-works/pi-tui"],
	["senpi-codemode", "@code-yeongyu/senpi-codemode"],
]);

function writeCodingAgentManifest(root) {
	writeJson(join(root, "packages", "coding-agent", "package.json"), {
		name: "@code-yeongyu/senpi",
		version: "2026.7.22",
		files: ["dist", "README.md"],
		dependencies: Object.fromEntries(ALL_WORKSPACE_NAMES.map((name) => [name, "^2026.7.22"])),
		bundleDependencies: [...BUNDLED_WORKSPACE_NAMES],
		bundledDependencies: [...BUNDLED_WORKSPACE_NAMES],
	});
}

function bundledWorkspaceFiles(workspace) {
	if (workspace === "pty") {
		return ["package.json", "dist/index.js", "native/index.js", nativePrebuildFile(nativePrebuildTarget())];
	}
	if (workspace === "senpi-codemode") {
		return ["package.json", "src/index.ts", "src/kernels/py/prelude.py"];
	}
	if (workspace === "client") {
		return ["package.json", "dist/index.js", "dist/index.d.ts", "dist/client.d.ts"];
	}
	if (workspace === "protocol") {
		return ["package.json", "dist/index.js", "dist/index.d.ts"];
	}
	return ["package.json", "dist/index.js"];
}

function writeBundledWorkspace(root, workspace) {
	const sourceRoot = join(root, "packages", workspace);
	const files = bundledWorkspaceFiles(workspace);

	for (const file of files) {
		if (file === "package.json") {
			const dependencies =
				workspace === "agent"
					? { "@earendil-works/pi-ai": "^1.0.0" }
					: workspace === "client"
						? { "@earendil-works/pi-protocol": "1.0.0" }
						: undefined;
			writeJson(join(sourceRoot, file), {
				name: BUNDLED_WORKSPACE_PACKAGE_NAMES.get(workspace),
				version: "1.0.0",
				...(dependencies ? { dependencies } : {}),
				...(workspace === "senpi-codemode"
					? {
							devDependencies: { "@code-yeongyu/senpi": "1.0.0" },
							peerDependencies: { "@code-yeongyu/senpi": "*" },
						}
					: {}),
			});
		} else {
			const filePath = join(sourceRoot, file);
			mkdirSync(dirname(filePath), { recursive: true });
			const contents =
				workspace === "client" && file === "dist/client.d.ts"
					? 'import type { SessionSnapshot } from "@earendil-works/pi-protocol";\n'
					: "";
			writeFileSync(filePath, contents);
		}
	}
}

describe("prepareSenpiBundledWorkspaces", () => {
	it("copies the loader-visible host pty prebuild into coding-agent node_modules", () => {
		// Given
		tempDir = mkdtempSync(join(tmpdir(), "senpi-bundle-workspaces-"));
		writeShrinkwrap(tempDir, { "": { dependencies: {} } });
		writeCodingAgentManifest(tempDir);
		for (const workspace of ["agent", "ai", "client", "protocol", "pty", "telemetry", "tui", "senpi-codemode"]) {
			writeBundledWorkspace(tempDir, workspace);
		}

		// When
		prepareSenpiBundledWorkspaces(tempDir);

		// Then
		assert.equal(
			readFileSync(
				join(
					tempDir,
					"packages",
					"coding-agent",
					"node_modules",
					"@earendil-works",
					"pi-pty",
					nativePrebuildFile(nativePrebuildTarget()),
				),
				"utf8",
			),
			"",
		);
	});

	it("bundles pty with a pipe-fallback warning when the host prebuild is missing", () => {
		// Given: every loader-visible file present, but the host native prebuild absent.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-bundle-missing-pty-prebuild-"));
		writeShrinkwrap(tempDir, { "": { dependencies: {} } });
		writeCodingAgentManifest(tempDir);
		for (const workspace of ["agent", "ai", "client", "protocol", "telemetry", "tui", "senpi-codemode"]) {
			writeBundledWorkspace(tempDir, workspace);
		}
		writeBundledWorkspace(tempDir, "pty");
		rmSync(join(tempDir, "packages", "pty", nativePrebuildFile(nativePrebuildTarget())));

		const warnings = [];
		const originalWarn = console.warn;
		console.warn = (message) => warnings.push(String(message));

		// When / Then: the prebuild is optional (pipe fallback), so bundling must not throw.
		try {
			assert.doesNotThrow(() => prepareSenpiBundledWorkspaces(tempDir));
		} finally {
			console.warn = originalWarn;
		}

		// And: pty is still copied into coding-agent node_modules (loader files present).
		assert.equal(
			readFileSync(
				join(tempDir, "packages", "coding-agent", "node_modules", "@earendil-works", "pi-pty", "native", "index.js"),
				"utf8",
			),
			"",
		);
		// And: a warning names the missing prebuild.
		assert.ok(
			warnings.some((message) => /no native prebuild/.test(message)),
			`expected a pipe-fallback warning, got: ${JSON.stringify(warnings)}`,
		);
	});

	it("rewrites the publish manifest so bundleDependencies covers every staged package", () => {
		// Given: a registry runtime dep (cross-spawn) plus its hoisted transitive (which) are
		// installed at the repo root and enumerated by the staging lock.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-bundle-manifest-"));
		writeShrinkwrap(tempDir, {
			"": { dependencies: { "cross-spawn": "7.0.6" } },
			"node_modules/cross-spawn": { version: "7.0.6" },
			"node_modules/which": { version: "2.0.2" },
			"node_modules/@code-yeongyu/senpi-codemode/node_modules/@babel/parser": { version: "8.0.4" },
			"node_modules/@code-yeongyu/senpi-codemode/node_modules/@babel/types": { version: "8.0.4" },
			"node_modules/@code-yeongyu/senpi-codemode/node_modules/typebox": { version: "1.3.8" },
		});
		writeCodingAgentManifest(tempDir);
		const publicDeclarationPath = join(tempDir, "packages", "coding-agent", "dist", "client", "remote-session.d.ts");
		mkdirSync(dirname(publicDeclarationPath), { recursive: true });
		writeFileSync(
			publicDeclarationPath,
			[
				'import type { PiClient } from "@earendil-works/pi-client";',
				'import type { SessionSnapshot } from "@earendil-works/pi-protocol";',
				"",
			].join("\n"),
		);
		for (const packageName of ["pi-client", "pi-protocol"]) {
			writeJson(
				join(
					tempDir,
					"packages",
					"coding-agent",
					"node_modules",
					"@earendil-works",
					packageName,
					"package.json",
				),
				{ name: `@earendil-works/${packageName}`, version: "stale" },
			);
		}
		for (const workspace of ["agent", "ai", "client", "protocol", "pty", "telemetry", "tui", "senpi-codemode"]) {
			writeBundledWorkspace(tempDir, workspace);
		}
		for (const name of ["cross-spawn", "which"]) {
			writeJson(join(tempDir, "node_modules", name, "package.json"), { name, version: "1.0.0" });
		}
		for (const name of ["@babel/parser", "@babel/types", "@babel/unlocked", "typebox"]) {
			writeJson(join(tempDir, "packages", "senpi-codemode", "node_modules", name, "package.json"), {
				name,
				version: "8.0.4",
			});
		}
		for (const artifact of [".bin", ".vite"]) {
			writeJson(join(tempDir, "packages", "senpi-codemode", "node_modules", artifact, "package.json"), {
				name: `${artifact}-artifact`,
			});
		}

		// When
		prepareSenpiBundledWorkspaces(tempDir);

		// Then: the registry dep AND its transitive are staged...
		for (const packageName of ["pi-client", "pi-protocol"]) {
			assert.equal(
				existsSync(
					join(tempDir, "packages", "coding-agent", "node_modules", "@earendil-works", packageName),
				),
				false,
			);
		}
		for (const name of ["cross-spawn", "which"]) {
			assert.equal(
				JSON.parse(
					readFileSync(join(tempDir, "packages", "coding-agent", "node_modules", name, "package.json"), "utf8"),
				).name,
				name,
			);
		}
		const stagedCodemodeNodeModules = join(
			tempDir,
			"packages",
			"coding-agent",
			"node_modules",
			"@code-yeongyu",
			"senpi-codemode",
			"node_modules",
		);
		for (const name of ["@babel/parser", "@babel/types", "typebox"]) {
			assert.equal(JSON.parse(readFileSync(join(stagedCodemodeNodeModules, name, "package.json"), "utf8")).name, name);
		}
		assert.equal(existsSync(join(stagedCodemodeNodeModules, "@babel/unlocked")), false);
		assert.equal(existsSync(join(stagedCodemodeNodeModules, ".bin")), false);
		assert.equal(existsSync(join(stagedCodemodeNodeModules, ".vite")), false);
		// ...and the manifest lists every registry-backed staged package. Client and
		// protocol are ordinary vendored files with relative declaration imports, so
		// Bun never sees registry edges for their unpublished upstream package names.
		const manifest = JSON.parse(readFileSync(join(tempDir, "packages", "coding-agent", "package.json"), "utf8"));
		const expectedBundle = [...BUNDLED_WORKSPACE_NAMES, "cross-spawn", "which"].sort((a, b) => a.localeCompare(b));
		assert.deepEqual(manifest.bundleDependencies, expectedBundle);
		assert.deepEqual(manifest.bundledDependencies, expectedBundle);
		assert.deepEqual(manifest.files, ["dist", "README.md", "vendor"]);
		assert.deepEqual(manifest.dependencies, {
			"@code-yeongyu/senpi-codemode": "2026.7.22",
			"@earendil-works/pi-agent-core": "npm:@code-yeongyu/senpi-agent-core@2026.7.22",
			"@earendil-works/pi-ai": "npm:@code-yeongyu/senpi-ai@2026.7.22",
			"@earendil-works/pi-pty": "npm:@code-yeongyu/senpi-pty@2026.7.22",
			"@earendil-works/pi-telemetry": "npm:@code-yeongyu/senpi-telemetry@2026.7.22",
			"@earendil-works/pi-tui": "npm:@code-yeongyu/senpi-tui@2026.7.22",
			"cross-spawn": "1.0.0",
			which: "1.0.0",
		});
		const stagedAgentManifest = JSON.parse(
			readFileSync(
				join(
					tempDir,
					"packages",
					"coding-agent",
					"node_modules",
					"@earendil-works",
					"pi-agent-core",
					"package.json",
				),
				"utf8",
			),
		);
		assert.deepEqual(stagedAgentManifest.dependencies, {
			"@earendil-works/pi-ai": "npm:@code-yeongyu/senpi-ai@1.0.0",
		});
		assert.equal(
			readFileSync(join(tempDir, "packages", "coding-agent", "vendor", "pi-protocol", "index.js"), "utf8"),
			"",
		);
		const stagedCodemodeManifest = JSON.parse(
			readFileSync(
				join(
					tempDir,
					"packages",
					"coding-agent",
					"node_modules",
					"@code-yeongyu",
					"senpi-codemode",
					"package.json",
				),
				"utf8",
			),
		);
		assert.deepEqual(stagedCodemodeManifest.peerDependencies, {
			"@code-yeongyu/senpi": "1.0.0",
		});
		assert.match(
			readFileSync(publicDeclarationPath, "utf8"),
			/\.\.\/\.\.\/vendor\/pi-client\/index\.js/,
		);
		assert.match(
			readFileSync(publicDeclarationPath, "utf8"),
			/\.\.\/\.\.\/vendor\/pi-protocol\/index\.js/,
		);
		assert.match(
			readFileSync(
				join(tempDir, "packages", "coding-agent", "vendor", "pi-client", "client.d.ts"),
				"utf8",
			),
			/\.\.\/pi-protocol\/index\.js/,
		);
	});

	it("rejects unresolved client or protocol specifiers after rewriting", () => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-vendor-specifier-leak-"));
		writeShrinkwrap(tempDir, { "": { dependencies: {} } });
		writeCodingAgentManifest(tempDir);
		for (const workspace of ["agent", "ai", "client", "protocol", "pty", "telemetry", "tui", "senpi-codemode"]) {
			writeBundledWorkspace(tempDir, workspace);
		}
		const leakedImport = join(tempDir, "packages", "coding-agent", "dist", "leak.js");
		mkdirSync(dirname(leakedImport), { recursive: true });
		writeFileSync(leakedImport, 'import "@earendil-works/pi-protocol/schemas";\n');

		assert.throws(
			() => prepareSenpiBundledWorkspaces(tempDir),
			/still references resolver-visible package @earendil-works\/pi-protocol/,
		);
	});

	it("rejects undeclared runtime dependencies required by vendored workspaces", () => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-vendor-runtime-dependency-"));
		writeShrinkwrap(tempDir, { "": { dependencies: {} } });
		writeCodingAgentManifest(tempDir);
		for (const workspace of ["agent", "ai", "client", "protocol", "pty", "telemetry", "tui", "senpi-codemode"]) {
			writeBundledWorkspace(tempDir, workspace);
		}
		writeJson(join(tempDir, "packages", "protocol", "package.json"), {
			name: "@earendil-works/pi-protocol",
			version: "1.0.0",
			dependencies: {
				typebox: "1.0.0",
			},
		});

		assert.throws(
			() => prepareSenpiBundledWorkspaces(tempDir),
			/requires typebox, which is absent from @code-yeongyu\/senpi runtime dependencies/,
		);
	});

	it("fails before bundling pty when a loader-visible file is missing", () => {
		// Given: the hard-required loader file native/index.js is absent.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-bundle-missing-pty-loader-"));
		writeShrinkwrap(tempDir, { "": { dependencies: {} } });
		writeCodingAgentManifest(tempDir);
		for (const workspace of ["agent", "ai", "client", "protocol", "telemetry", "tui"]) {
			writeBundledWorkspace(tempDir, workspace);
		}
		writeBundledWorkspace(tempDir, "pty");
		rmSync(join(tempDir, "packages", "pty", "native", "index.js"));

		// When / Then: a missing loader file is still fatal.
		assert.throws(
			() => prepareSenpiBundledWorkspaces(tempDir),
			/Missing .*native\/index\.js.*cannot be bundled/,
		);
	});
});
