import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, it } from "node:test";

let root;
let source;
let out;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sidecar-closure-"));
	source = join(root, "source");
	out = join(root, "out");
	mkdirSync(source);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function pkg(path, name, dependencies = {}) {
	mkdirSync(path, { recursive: true });
	const version = name === "x3" ? "3.0.0" : name === "b2" ? "2.0.0" : "1.0.0";
	writeFileSync(join(path, "package.json"), JSON.stringify({ name, version, dependencies, files: ["index.js"] }));
	writeFileSync(join(path, "index.js"), `module.exports = ${JSON.stringify(name)};`);
}
function run() {
	return spawnSync(process.execPath, [resolve("scripts/copy-codemode-sidecar.mjs"), out, join(source, "package.json")], {
		encoding: "utf8", env: { ...process.env, SENPI_SIDECAR_EXCLUDE: "" },
	});
}

it("preserves every source dependency edge when three nesting levels can shadow a hoisted version", () => {
	// Given the verifier's three-level layout.
	pkg(source, "codemode", { c: "1", d: "1" });
	const modules = join(source, "node_modules");
	pkg(join(modules, "c"), "c", { x: "3", b: "1" });
	pkg(join(modules, "c/node_modules/x"), "x3");
	pkg(join(modules, "d"), "d", { b: "2" });
	pkg(join(modules, "d/node_modules/b"), "b2");
	pkg(join(modules, "b"), "b1", { x: "1" });
	pkg(join(modules, "x"), "x1");
	writeFileSync(join(modules, "c/index.js"), "module.exports = require('x') + ';' + require('b');");
	writeFileSync(join(modules, "b/index.js"), "module.exports = 'b1:' + require('x');");
	const packagePaths = ["@code-yeongyu/senpi-codemode", "c", "c/node_modules/x", "d", "d/node_modules/b", "b", "x"];
	const edges = packagePaths.flatMap((path) => {
		const manifest = path === "@code-yeongyu/senpi-codemode"
			? join(source, "package.json")
			: join(modules, path, "package.json");
		return Object.keys(JSON.parse(readFileSync(manifest)).dependencies ?? {}).map((dep) => ({
			path, dep, version: createRequire(manifest)(`${dep}/package.json`).version,
		}));
	});
	// When copying the closure.
	const result = run();
	// Then every staged edge resolves the source version, even after source removal.
	assert.equal(result.status, 0, result.stderr);
	rmSync(source, { recursive: true });
	assert.equal(createRequire(join(out, "entry.js"))("c"), "x3;b1:x1");
	for (const { path, dep, version } of edges) {
		assert.equal(createRequire(join(out, "node_modules", path, "package.json"))(`${dep}/package.json`).version, version);
	}
});

it("omits undeclared nested packages when copying a dependency directory", () => {
	// Given a dependency with an unneeded nested install.
	pkg(source, "codemode", { a: "1" });
	pkg(join(source, "node_modules/a"), "a");
	pkg(join(source, "node_modules/a/node_modules/unneeded"), "unneeded");
	// When copying.
	const result = run();
	// Then the undeclared package is absent.
	assert.equal(result.status, 0, result.stderr);
	assert.equal(existsSync(join(out, "node_modules/a/node_modules/unneeded")), false);
});

it("resolves dependencies from the real workspace root rather than its symlink parent", () => {
	// Given two versions visible from the workspace and symlink locations.
	pkg(source, "codemode", { a: "1" });
	const workspace = join(root, "workspace");
	pkg(workspace, "a", { x: "1" });
	const workspaceManifest = JSON.parse(readFileSync(join(workspace, "package.json")));
	workspaceManifest.exports = { ".": "./index.js" };
	writeFileSync(join(workspace, "package.json"), JSON.stringify(workspaceManifest));
	pkg(join(root, "node_modules/x"), "workspace-x");
	pkg(join(source, "node_modules/x"), "wrong-x");
	mkdirSync(join(source, "node_modules"), { recursive: true });
	symlinkSync(workspace, join(source, "node_modules/a"), "junction");
	writeFileSync(join(workspace, "index.js"), "module.exports = require('x');");
	// When copying the workspace closure.
	const result = run();
	// Then the runtime uses the same version as the real source, from the staged copy alone.
	assert.equal(result.status, 0, result.stderr);
	rmSync(source, { recursive: true });
	rmSync(workspace, { recursive: true });
	rmSync(join(root, "node_modules"), { recursive: true });
	assert.equal(createRequire(join(out, "entry.js"))("a"), "workspace-x");
});

it("dereferences manifest payload symlinks when shipping selected files", () => {
	// Given a symlink in files, not in a dependency.
	pkg(source, "codemode");
	writeFileSync(join(root, "payload.js"), "module.exports = 'payload';");
	rmSync(join(source, "index.js"));
	symlinkSync(join(root, "payload.js"), join(source, "index.js"));
	// When staging.
	const result = run();
	// Then the shipped entry works after the link target disappears.
	assert.equal(result.status, 0, result.stderr);
	rmSync(join(root, "payload.js"));
	assert.equal(createRequire(join(out, "entry.js"))("./node_modules/@code-yeongyu/senpi-codemode/index.js"), "payload");
});

it("names the dependency in the packaging error rather than only its nested cause", () => {
	// Given an absent required dependency.
	pkg(source, "codemode", { missing: "1" });
	// When staging fails.
	const result = run();
	// Then the outer diagnostic names the missing dependency.
	assert.equal(result.status, 1);
	assert.match(result.stderr.split("\n").find((line) => line.startsWith("Error:")), /missing/);
});

it("preserves unrelated output packages when clearing previously owned packages", () => {
	// Given a staged closure and an unrelated package.
	pkg(source, "codemode", { old: "1" });
	pkg(join(source, "node_modules/old"), "old");
	assert.equal(run().status, 0);
	pkg(join(out, "node_modules/unrelated"), "unrelated");
	pkg(source, "codemode");
	// When restaging without the old dependency.
	const result = run();
	// Then only the owned package disappears.
	assert.equal(result.status, 0, result.stderr);
	assert.equal(existsSync(join(out, "node_modules/old")), false);
	assert.equal(createRequire(join(out, "entry.js"))("unrelated"), "unrelated");
});

it("refuses package output roots before modifying their installs", () => {
	// Given an output directory that is itself a package.
	pkg(source, "codemode");
	pkg(out, "protected");
	pkg(join(out, "node_modules/keep"), "keep");
	// When asked to stage there.
	const result = run();
	// Then it fails without destroying the install.
	assert.equal(result.status, 1);
	assert.equal(createRequire(join(out, "entry.js"))("keep"), "keep");
});

it("stages present optional dependencies and skips absent ones throughout the closure", () => {
	// Given both present and absent optional dependencies at two levels.
	pkg(source, "codemode", { a: "1" });
	pkg(join(source, "node_modules/a"), "a");
	for (const path of [source, join(source, "node_modules/a")]) {
		const manifest = JSON.parse(readFileSync(join(path, "package.json")));
		manifest.optionalDependencies = path === source
			? { present: "1", absent: "1" }
			: { "nested-present": "1", "nested-absent": "1" };
		writeFileSync(join(path, "package.json"), JSON.stringify(manifest));
	}
	pkg(join(source, "node_modules/present"), "present");
	pkg(join(source, "node_modules/a/node_modules/nested-present"), "nested-present");
	// When staging the optional closure.
	const result = run();
	// Then a present payload runs and missing platform payloads do not fail packaging.
	assert.equal(result.status, 0, result.stderr);
	rmSync(source, { recursive: true });
	assert.equal(createRequire(join(out, "entry.js"))("present"), "present");
	assert.equal(createRequire(join(out, "node_modules/a/package.json"))("nested-present"), "nested-present");
	assert.equal(existsSync(join(out, "node_modules/absent")), false);
});

it("refuses a dependency collision without replacing an unrelated existing package", () => {
	// Given an output package not owned by the copier.
	pkg(source, "codemode", { a: "1" });
	pkg(join(source, "node_modules/a"), "a");
	pkg(join(out, "node_modules/a"), "unrelated-a");
	// When the closure requires that same destination.
	const result = run();
	// Then packaging fails and the unrelated install remains usable.
	assert.equal(result.status, 1);
	assert.equal(createRequire(join(out, "entry.js"))("a"), "unrelated-a");
});

it("refuses a store-linked dependency whose staged mirror would resolve a different version", () => {
	// Given a dependent linked into a store copy while a different version is hoisted.
	pkg(source, "codemode", { a: "1", dep: "1" });
	const modules = join(source, "node_modules");
	pkg(join(modules, "a"), "a", { dep: "1" });
	writeFileSync(join(modules, "a/index.js"), "module.exports = require('dep');");
	pkg(join(modules, "dep"), "dep-hoisted");
	pkg(join(modules, ".store/dep@2/node_modules/dep"), "dep-store");
	mkdirSync(join(modules, "a/node_modules"));
	symlinkSync(join(modules, ".store/dep@2/node_modules/dep"), join(modules, "a/node_modules/dep"), "junction");
	assert.equal(createRequire(join(modules, "a/package.json"))("dep"), "dep-store");
	// When staging a closure whose mirrored edge would silently switch versions.
	const result = run();
	// Then packaging fails instead of shipping the hoisted version to the dependent.
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Conflicting codemode sidecar dependency dep required by/);
});

it("stages a package shared by two dependents once when both resolve the same source", () => {
	// Given a diamond graph whose dependents share one hoisted package.
	pkg(source, "codemode", { left: "1", right: "1" });
	const modules = join(source, "node_modules");
	for (const name of ["left", "right"]) {
		pkg(join(modules, name), name, { shared: "1" });
		writeFileSync(join(modules, name, "index.js"), `module.exports = ${JSON.stringify(name)} + ':' + require('shared');`);
	}
	pkg(join(modules, "shared"), "shared");
	// When staging the diamond.
	const result = run();
	// Then both dependents run against the single staged package.
	assert.equal(result.status, 0, result.stderr);
	rmSync(source, { recursive: true });
	const require = createRequire(join(out, "entry.js"));
	assert.equal(require("left"), "left:shared");
	assert.equal(require("right"), "right:shared");
});

it("rejects tampered ownership entries without removing anything outside the output install", () => {
	for (const tampered of [join("node_modules", "..", "..", "victim"), join(root, "victim")]) {
		// Given a staged output whose journal points outside its install.
		rmSync(out, { recursive: true, force: true });
		pkg(source, "codemode", { keep: "1" });
		pkg(join(source, "node_modules/keep"), "keep");
		assert.equal(run().status, 0);
		mkdirSync(join(root, "victim"), { recursive: true });
		writeFileSync(join(root, "victim/f"), "victim");
		writeFileSync(join(out, ".codemode-sidecar.json"), JSON.stringify([tampered]));
		// When restaging.
		const result = run();
		// Then the copier refuses and both the victim and the staged install survive.
		assert.equal(result.status, 1, tampered);
		assert.match(result.stderr, /Invalid codemode sidecar ownership path/);
		assert.equal(readFileSync(join(root, "victim/f"), "utf8"), "victim");
		assert.equal(createRequire(join(out, "entry.js"))("keep"), "keep");
	}
});
