import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	"@earendil-works/pi-tui",
	"@code-yeongyu/senpi-codemode",
];

function writeCodingAgentManifest(root) {
	writeJson(join(root, "packages", "coding-agent", "package.json"), {
		name: "@code-yeongyu/senpi",
		version: "2026.7.22",
		dependencies: Object.fromEntries(BUNDLED_WORKSPACE_NAMES.map((name) => [name, "^2026.7.22"])),
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
	return ["package.json", "dist/index.js"];
}

function writeBundledWorkspace(root, workspace) {
	const sourceRoot = join(root, "packages", workspace);
	const files = bundledWorkspaceFiles(workspace);

	for (const file of files) {
		if (file === "package.json") {
			writeJson(join(sourceRoot, file), { name: workspace, version: "1.0.0" });
		} else {
			const filePath = join(sourceRoot, file);
			mkdirSync(dirname(filePath), { recursive: true });
			writeFileSync(filePath, "");
		}
	}
}

describe("prepareSenpiBundledWorkspaces", () => {
	it("copies the loader-visible host pty prebuild into coding-agent node_modules", () => {
		// Given
		tempDir = mkdtempSync(join(tmpdir(), "senpi-bundle-workspaces-"));
		writeShrinkwrap(tempDir, { "": { dependencies: {} } });
		writeCodingAgentManifest(tempDir);
		for (const workspace of ["agent", "ai", "pty", "tui", "senpi-codemode"]) {
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
		for (const workspace of ["agent", "ai", "tui", "senpi-codemode"]) {
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
		});
		writeCodingAgentManifest(tempDir);
		for (const workspace of ["agent", "ai", "pty", "tui", "senpi-codemode"]) {
			writeBundledWorkspace(tempDir, workspace);
		}
		for (const name of ["cross-spawn", "which"]) {
			writeJson(join(tempDir, "node_modules", name, "package.json"), { name, version: "1.0.0" });
		}

		// When
		prepareSenpiBundledWorkspaces(tempDir);

		// Then: the registry dep AND its transitive are staged...
		for (const name of ["cross-spawn", "which"]) {
			assert.equal(
				JSON.parse(
					readFileSync(join(tempDir, "packages", "coding-agent", "node_modules", name, "package.json"), "utf8"),
				).name,
				name,
			);
		}
		// ...and the manifest lists every staged package. npm retains the original
		// import-path keys for bundling, while Bun resolves upstream-named packages
		// through the fork-owned aliases.
		const manifest = JSON.parse(readFileSync(join(tempDir, "packages", "coding-agent", "package.json"), "utf8"));
		const expectedBundle = [...BUNDLED_WORKSPACE_NAMES, "cross-spawn", "which"].sort((a, b) => a.localeCompare(b));
		assert.deepEqual(manifest.bundleDependencies, expectedBundle);
		assert.deepEqual(manifest.bundledDependencies, expectedBundle);
		assert.deepEqual(manifest.dependencies, {
			"@code-yeongyu/senpi-codemode": "^2026.7.22",
			"@earendil-works/pi-agent-core": "npm:@code-yeongyu/senpi-agent-core@^2026.7.22",
			"@earendil-works/pi-ai": "npm:@code-yeongyu/senpi-ai@^2026.7.22",
			"@earendil-works/pi-pty": "npm:@code-yeongyu/senpi-pty@^2026.7.22",
			"@earendil-works/pi-tui": "npm:@code-yeongyu/senpi-tui@^2026.7.22",
		});
	});

	it("fails before bundling pty when a loader-visible file is missing", () => {
		// Given: the hard-required loader file native/index.js is absent.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-bundle-missing-pty-loader-"));
		writeShrinkwrap(tempDir, { "": { dependencies: {} } });
		writeCodingAgentManifest(tempDir);
		for (const workspace of ["agent", "ai", "tui"]) {
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
