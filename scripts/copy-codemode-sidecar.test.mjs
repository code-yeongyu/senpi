import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import ts from "@typescript/typescript6";

const scriptPath = resolve("scripts/copy-codemode-sidecar.mjs");
let fixtureRoot;
let sourceRoot;
let outputRoot;
let manifestPath;

beforeEach(() => {
	fixtureRoot = mkdtempSync(join(tmpdir(), "senpi-codemode-sidecar-"));
	sourceRoot = join(fixtureRoot, "source");
	outputRoot = join(fixtureRoot, "output");
	manifestPath = join(sourceRoot, "package.json");
	mkdirSync(sourceRoot, { recursive: true });
	writeFileSync(join(sourceRoot, "index.js"), "module.exports = 'codemode';\n");
});

afterEach(() => {
	rmSync(fixtureRoot, { recursive: true, force: true });
});

function declareDependencies(dependencies) {
	writeFileSync(manifestPath, JSON.stringify({
		name: "@code-yeongyu/senpi-codemode",
		files: ["index.js"],
		dependencies,
	}));
}

function addPackage(root, manifest) {
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
	writeFileSync(join(root, "index.js"), `module.exports = ${JSON.stringify(manifest.version)};\n`);
}

function hostPackageRoots() {
	const loader = ts.createSourceFile("loader.ts", readFileSync(
		resolve("packages/coding-agent/src/core/extensions/loader.ts"), "utf8",
	), ts.ScriptTarget.Latest, true);
	const roots = new Set();
	function visit(node) {
		if (ts.isVariableDeclaration(node) && node.name.getText(loader) === "VIRTUAL_MODULES") {
			assert.ok(node.initializer && ts.isObjectLiteralExpression(node.initializer));
			for (const property of node.initializer.properties) {
				const specifier = property.name.text;
				roots.add(specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/"));
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(loader);
	assert.ok(roots.size > 0);
	return roots;
}

function runCopier(env = {}) {
	return spawnSync(process.execPath, [scriptPath, outputRoot, manifestPath], {
		encoding: "utf8",
		env: { ...process.env, SENPI_SIDECAR_EXCLUDE: "", ...env },
	});
}

describe("copy-codemode-sidecar", () => {
	it("copies the runtime payload and transitive dependency when the manifest declares them", () => {
		// Given an isolated manifest and a dependency with a private transitive package.
		declareDependencies({ "fake-dependency": "1.0.0" });
		const dependencyRoot = join(sourceRoot, "node_modules", "fake-dependency");
		addPackage(dependencyRoot, {
			name: "fake-dependency", version: "1.0.0", dependencies: { "fake-transitive": "2.0.0" },
		});
		addPackage(join(dependencyRoot, "node_modules", "fake-transitive"), {
			name: "fake-transitive", version: "2.0.0",
		});
		mkdirSync(join(sourceRoot, "test"));
		writeFileSync(join(sourceRoot, "test", "private.js"), "private");
		// When the sidecar is staged.
		const result = runCopier();
		// Then its shipped entry and both dependencies run without the source tree.
		assert.equal(result.status, 0, result.stderr);
		rmSync(sourceRoot, { recursive: true });
		const require = createRequire(join(outputRoot, "node_modules", "@code-yeongyu", "senpi-codemode", "package.json"));
		assert.equal(require("./index.js"), "codemode");
		assert.equal(require("fake-dependency"), "1.0.0");
		assert.equal(createRequire(require.resolve("fake-dependency"))("fake-transitive"), "2.0.0");
		assert.equal(existsSync(join(outputRoot, "node_modules", "@code-yeongyu", "senpi-codemode", "test")), false);
	});

	it("skips every host virtual package root and its exclusive dependencies", () => {
		// Given the host's real table, independently enumerated by the TypeScript parser.
		const roots = hostPackageRoots();
		declareDependencies(Object.fromEntries([...roots].map((root) => [root, "1.0.0"])));
		for (const name of roots) {
			addPackage(join(sourceRoot, "node_modules", name), {
				name, version: "1.0.0", dependencies: { "host-only-unresolved": "1.0.0" },
			});
		}
		// When staging dependencies provided by the host.
		const result = runCopier();
		// Then no host tree is traversed or written at the actual output location.
		assert.equal(result.status, 0, result.stderr);
		for (const name of roots) {
			assert.equal(existsSync(join(outputRoot, "node_modules", name)), false, name);
		}
	});

	it("skips host virtual packages reached through a transitive dependency", () => {
		// Given a staged dependency that depends on every host package root.
		const roots = hostPackageRoots();
		declareDependencies({ "host-consumer": "1.0.0" });
		addPackage(join(sourceRoot, "node_modules", "host-consumer"), {
			name: "host-consumer", version: "1.0.0", dependencies: Object.fromEntries([...roots].map((root) => [root, "1.0.0"])),
		});
		for (const name of roots) {
			addPackage(join(sourceRoot, "node_modules", name), { name, version: "1.0.0" });
		}
		// When staging the consumer.
		const result = runCopier();
		// Then the consumer ships and the host provides every virtual package instead.
		assert.equal(result.status, 0, result.stderr);
		assert.equal(createRequire(join(outputRoot, "entry.js"))("host-consumer"), "1.0.0");
		for (const name of roots) {
			assert.equal(existsSync(join(outputRoot, "node_modules", name)), false, name);
		}
	});

	it("dereferences workspace and file symlinks when a dependency hides its manifest export", () => {
		// Given a workspace package whose package.json cannot be resolved through exports.
		declareDependencies({ "workspace-dependency": "1.0.0" });
		renameSync(manifestPath, join(fixtureRoot, "manifest.json"));
		symlinkSync(join(fixtureRoot, "manifest.json"), manifestPath);
		const workspaceRoot = join(fixtureRoot, "workspace");
		addPackage(workspaceRoot, {
			name: "workspace-dependency", version: "3.0.0", exports: { ".": "./index.js" },
		});
		writeFileSync(join(fixtureRoot, "asset.txt"), "workspace asset");
		symlinkSync(join(fixtureRoot, "asset.txt"), join(workspaceRoot, "asset.txt"));
		mkdirSync(join(sourceRoot, "node_modules"));
		symlinkSync(workspaceRoot, join(sourceRoot, "node_modules", "workspace-dependency"), "junction");
		// When the workspace dependency is staged.
		const result = runCopier();
		// Then the tree has no links and remains usable after the workspace is removed.
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(readdirSync(outputRoot, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isSymbolicLink()).map((entry) => entry.name), []);
		rmSync(workspaceRoot, { recursive: true });
		rmSync(join(fixtureRoot, "asset.txt"));
		const require = createRequire(join(outputRoot, "entry.js"));
		assert.equal(require("workspace-dependency"), "3.0.0");
		assert.equal(readFileSync(join(outputRoot, "node_modules", "workspace-dependency", "asset.txt"), "utf8"), "workspace asset");
	});

	it("removes stale dependency files when staging twice into the same output", () => {
		// Given an already-staged output with removed packages and stale files.
		declareDependencies({ "@babel/parser": "1.0.0", "removed-dep": "1.0.0" });
		addPackage(join(sourceRoot, "node_modules", "@babel", "parser"), { name: "@babel/parser", version: "1.0.0" });
		addPackage(join(sourceRoot, "node_modules", "removed-dep"), { name: "removed-dep", version: "1.0.0" });
		const first = runCopier();
		assert.equal(first.status, 0, first.stderr);
		declareDependencies({ "@babel/parser": "1.0.0" });
		writeFileSync(join(outputRoot, "node_modules", "@babel", "parser", "STALE.txt"), "stale");
		// When staging again.
		const result = runCopier();
		// Then the rerun succeeds and both stale locations are gone.
		assert.equal(result.status, 0, result.stderr);
		assert.equal(existsSync(join(outputRoot, "node_modules", "removed-dep")), false);
		assert.equal(existsSync(join(outputRoot, "node_modules", "@babel", "parser", "STALE.txt")), false);
	});

	it("preserves each dependent's version when nested dependency names conflict", () => {
		// Given two dependents with different private versions of one dependency.
		declareDependencies({ "consumer-left": "1.0.0", "consumer-right": "1.0.0" });
		for (const [name, version] of [["consumer-left", "1.0.0"], ["consumer-right", "2.0.0"]]) {
			const root = join(sourceRoot, "node_modules", name);
			addPackage(root, { name, version: "1.0.0", dependencies: { "shared-version": version } });
			writeFileSync(join(root, "index.js"), "module.exports = require('shared-version');\n");
			addPackage(join(root, "node_modules", "shared-version"), { name: "shared-version", version });
		}
		// When both dependency graphs are staged.
		const result = runCopier();
		// Then each staged consumer resolves its own required version.
		assert.equal(result.status, 0, result.stderr);
		rmSync(sourceRoot, { recursive: true });
		const require = createRequire(join(outputRoot, "entry.js"));
		assert.equal(require("consumer-left"), "1.0.0");
		assert.equal(require("consumer-right"), "2.0.0");
	});

	it("names the unresolved package when a declared dependency is absent", () => {
		// Given an isolated manifest with an absent dependency.
		declareDependencies({ "fake-dep-does-not-exist": "1.0.0" });
		// When staging fails.
		const result = runCopier();
		// Then the failure names the dependency rather than reporting success.
		assert.equal(result.status, 1);
		assert.match(result.stderr, /fake-dep-does-not-exist/);
	});

	it("omits an excluded package and its closure when the stripping hook is set", () => {
		// Given a real fixture package that would otherwise be copied.
		declareDependencies({ "strip-me": "1.0.0", "keep-me": "1.0.0" });
		addPackage(join(sourceRoot, "node_modules", "strip-me"), {
			name: "strip-me", version: "1.0.0", dependencies: { "stripped-transitive": "1.0.0" },
		});
		addPackage(join(sourceRoot, "node_modules", "keep-me"), { name: "keep-me", version: "1.0.0" });
		// When stripping that package for the release failure-path gate.
		const result = runCopier({ SENPI_SIDECAR_EXCLUDE: "strip-me" });
		// Then unrelated dependencies work and the excluded closure is not traversed.
		assert.equal(result.status, 0, result.stderr);
		assert.equal(existsSync(join(outputRoot, "node_modules", "strip-me")), false);
		assert.equal(createRequire(join(outputRoot, "entry.js"))("keep-me"), "1.0.0");
	});
});
