import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { copyPublishDependencies } from "./prepare-senpi-bundled-workspaces.mjs";

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

function writePackage(root, name, version = "1.0.0") {
	const packageDir = join(root, "node_modules", name);
	mkdirSync(packageDir, { recursive: true });
	writeJson(join(packageDir, "package.json"), { name, version });
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

describe("copyPublishDependencies", () => {
	it("preserves an exact dependency already installed in the coding-agent workspace", () => {
		// Given: npm nested the exact coding-agent dependency because the root has
		// a different transitive version.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-bundle-workspace-dep-"));
		writePackage(tempDir, "typebox", "1.3.7");
		writePackage(join(tempDir, "packages", "coding-agent"), "typebox", "1.3.8");
		writeShrinkwrap(tempDir, {
			"": { dependencies: { typebox: "1.3.8" } },
			"node_modules/typebox": { version: "1.3.8" },
		});

		// When
		copyPublishDependencies(tempDir);

		// Then
		assert.equal(
			JSON.parse(
				readFileSync(join(tempDir, "packages", "coding-agent", "node_modules", "typebox", "package.json"), "utf8"),
			).version,
			"1.3.8",
		);
	});

	it("copies dependencies nested beneath an internal workspace", () => {
		// Given
		tempDir = mkdtempSync(join(tmpdir(), "senpi-bundle-internal-dep-"));
		writePackage(join(tempDir, "packages", "coding-agent"), "@earendil-works/pi-ai", "2026.8.1");
		writePackage(join(tempDir, "packages", "ai"), "@google/genai", "2.13.0");
		writeShrinkwrap(tempDir, {
			"": { dependencies: { "@earendil-works/pi-ai": "^2026.8.1" } },
			"node_modules/@earendil-works/pi-ai": { version: "2026.8.1" },
			"node_modules/@earendil-works/pi-ai/node_modules/@google/genai": { version: "2.13.0" },
		});

		// When
		copyPublishDependencies(tempDir);

		// Then
		assert.equal(
			JSON.parse(
				readFileSync(
					join(
						tempDir,
						"packages",
						"coding-agent",
						"node_modules",
						"@earendil-works",
						"pi-ai",
						"node_modules",
						"@google",
						"genai",
						"package.json",
					),
					"utf8",
				),
			).version,
			"2.13.0",
		);
	});

	it("copies direct publish dependencies and skips internal workspaces and missing optional packages", () => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-bundle-deps-"));
		writePackage(tempDir, "typebox");
		writePackage(tempDir, "@scope/pkg");
		writeShrinkwrap(tempDir, {
			"": { dependencies: { typebox: "1.0.0" } },
			"node_modules/typebox": { version: "1.0.0" },
			"node_modules/@scope/pkg": { version: "1.0.0" },
			"node_modules/@earendil-works/pi-ai": { version: "1.0.0" },
			"node_modules/missing-optional": { version: "1.0.0", optional: true },
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
