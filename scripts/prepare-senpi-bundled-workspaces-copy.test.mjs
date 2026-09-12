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

	it("stages a Bun-compile-safe css-tree without touching the installed source tree", () => {
		// Given: css-tree resolves its data through createRequire at module scope, which the
		// compiled binaries built from the published tarball cannot serve from /$bunfs.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-bundle-compile-safe-"));
		const cssTreeSource = join(tempDir, "node_modules", "css-tree");
		mkdirSync(join(cssTreeSource, "lib"), { recursive: true });
		mkdirSync(join(cssTreeSource, "data"), { recursive: true });
		writeJson(join(cssTreeSource, "package.json"), { name: "css-tree", version: "3.2.1", type: "module" });
		writeFileSync(join(cssTreeSource, "data", "patch.json"), JSON.stringify({ properties: { color: { syntax: "<color>" } } }));
		const dataPatchSource =
			"import { createRequire } from 'module';\n\nconst require = createRequire(import.meta.url);\nconst patch = require('../data/patch.json');\n\nexport default patch;\n";
		writeFileSync(join(cssTreeSource, "lib", "data-patch.js"), dataPatchSource);
		writeShrinkwrap(tempDir, {
			"": { dependencies: { "css-tree": "3.2.1" } },
			"node_modules/css-tree": { version: "3.2.1" },
		});

		// When
		copyPublishDependencies(tempDir);

		// Then: the staged copy is compile-safe...
		const staged = readFileSync(
			join(tempDir, "packages", "coding-agent", "node_modules", "css-tree", "lib", "data-patch.js"),
			"utf8",
		);
		assert.doesNotMatch(staged, /createRequire/);
		assert.match(staged, /"color"/);

		// ...and publishing never rewrites the developer's installed dependency.
		assert.equal(readFileSync(join(cssTreeSource, "lib", "data-patch.js"), "utf8"), dataPatchSource);
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
