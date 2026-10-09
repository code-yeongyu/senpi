import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, it } from "node:test";

let root;
let source;
let out;
let stagedCodemode;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sidecar-ownership-"));
	source = join(root, "source");
	out = join(root, "out");
	stagedCodemode = join(out, "node_modules/@code-yeongyu/senpi-codemode");
	mkdirSync(source);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function pkg(path, name, dependencies = {}) {
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "package.json"), JSON.stringify({ name, version: "1.0.0", dependencies, files: ["index.js"] }));
	writeFileSync(join(path, "index.js"), `module.exports = ${JSON.stringify(name)};`);
}
function run() {
	return spawnSync(process.execPath, [resolve("scripts/copy-codemode-sidecar.mjs"), out, join(source, "package.json")], {
		encoding: "utf8", env: { ...process.env, SENPI_SIDECAR_EXCLUDE: "" },
	});
}

it("refuses a symlinked output node_modules without removing the unowned packages it points to", () => {
	// Given a staged output whose node_modules was replaced by a link to an unowned install.
	pkg(source, "codemode", { old: "1" });
	pkg(join(source, "node_modules/old"), "old");
	const first = run();
	assert.equal(first.status, 0, first.stderr);
	const external = join(root, "external");
	renameSync(join(out, "node_modules"), external);
	symlinkSync(external, join(out, "node_modules"), "junction");
	writeFileSync(join(external, "old/unowned.txt"), "unowned");
	// When restaging into that output.
	const result = run();
	// Then the copier refuses and every package behind the link survives.
	assert.equal(result.status, 1);
	assert.equal(readFileSync(join(external, "old/unowned.txt"), "utf8"), "unowned");
	assert.match(result.stderr, /Refusing to follow a symlinked codemode sidecar output path/);
});

it("refuses an unowned codemode package when no ownership record lists it", () => {
	// Given an output codemode package the copier never staged.
	pkg(source, "codemode");
	pkg(stagedCodemode, "@code-yeongyu/senpi-codemode");
	writeFileSync(join(stagedCodemode, "keep.txt"), "keep");
	// When staging into that output.
	const result = run();
	// Then the copier fails and leaves the package untouched.
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Refusing to overwrite unowned codemode sidecar package/);
	assert.equal(readFileSync(join(stagedCodemode, "keep.txt"), "utf8"), "keep");
});

it("replaces the codemode layout staged before ownership records existed", () => {
	// Given the earlier copier's output: codemode with its parser nested inside and no record.
	pkg(source, "codemode");
	pkg(stagedCodemode, "@code-yeongyu/senpi-codemode");
	pkg(join(stagedCodemode, "node_modules/@babel/parser"), "@babel/parser");
	writeFileSync(join(stagedCodemode, "STALE.txt"), "stale");
	// When staging into that output.
	const result = run();
	// Then the earlier layout is replaced by the current closure.
	assert.equal(result.status, 0, result.stderr);
	assert.equal(existsSync(join(stagedCodemode, "STALE.txt")), false);
	assert.equal(existsSync(join(stagedCodemode, "node_modules")), false);
	assert.equal(createRequire(join(out, "entry.js"))("@code-yeongyu/senpi-codemode"), "codemode");
});
