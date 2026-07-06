import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	assertSenpiPackedWorkspaceFiles,
	copyPublishDependencies,
	directNodeModulesPackageName,
} from "./prepare-senpi-bundled-workspaces.mjs";

let tempDir;

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function writeJson(path, value) {
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
	writeJson(join(codingAgentDir, "npm-shrinkwrap.json"), {
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
			files: [{ path: "package/dist/cli.js" }, { path: "package/npm-shrinkwrap.json" }],
		};

		// When / Then
		assert.throws(
			() => assertSenpiPackedWorkspaceFiles(packed),
			/package tarball is missing bundled workspace files: .*@earendil-works\/pi-ai/,
		);
	});

	it("accepts senpi package metadata that includes bundled workspace entrypoints", () => {
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
				{ path: "package/node_modules/@earendil-works/pi-pty/native/index.js" },
				{ path: "package/node_modules/@earendil-works/pi-tui/package.json" },
				{ path: "package/node_modules/@earendil-works/pi-tui/dist/index.js" },
			],
		};

		// When / Then
		assert.doesNotThrow(() => assertSenpiPackedWorkspaceFiles(packed));
	});

	it("accepts npm dry-run package metadata with unprefixed paths", () => {
		// Given
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
				{ path: "node_modules/@earendil-works/pi-tui/package.json" },
				{ path: "node_modules/@earendil-works/pi-tui/dist/index.js" },
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
});
