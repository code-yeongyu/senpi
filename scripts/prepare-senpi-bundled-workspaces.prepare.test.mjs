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
	writeJson(join(root, "packages", "coding-agent", "npm-shrinkwrap.json"), {
		name: "@code-yeongyu/senpi",
		version: "0.0.0",
		lockfileVersion: 3,
		requires: true,
		packages,
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

	it("fails before bundling pty when a loader-visible file is missing", () => {
		// Given: the hard-required loader file native/index.js is absent.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-bundle-missing-pty-loader-"));
		writeShrinkwrap(tempDir, { "": { dependencies: {} } });
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
