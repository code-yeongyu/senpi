#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, it } from "node:test";
import { stageImageGenSkill } from "./prepare-bun-compile-assets.mjs";

let tempDir;
afterEach(() => {
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

it("copies imagegen assets when preparing a standalone build", () => {
	// Given
	tempDir = mkdtempSync(join(tmpdir(), "senpi-imagegen-assets-"));
	const source = join(tempDir, "packages/coding-agent/src/core/extensions/builtin/imagegen/skill/SKILL.md");
	mkdirSync(dirname(source), { recursive: true });
	writeFileSync(source, "fixture skill\n");
	// When
	const prepared = stageImageGenSkill(tempDir);
	// Then: shipped-copy equality, not a prose pin.
	assert.equal(prepared, true);
	assert.deepEqual(readFileSync(join(tempDir, "packages/coding-agent/dist/core/extensions/builtin/imagegen/skill/SKILL.md")), readFileSync(source));
});

it("reports absent assets when the source skill is not installed", () => {
	// Given
	tempDir = mkdtempSync(join(tmpdir(), "senpi-imagegen-absent-"));
	// When / Then
	assert.equal(stageImageGenSkill(tempDir), false);
});

it("resolves the repository when invoked from a package directory", () => {
	// Given
	tempDir = mkdtempSync(join(tmpdir(), "senpi-imagegen-cwd-"));
	const source = join(tempDir, "packages/coding-agent/src/core/extensions/builtin/imagegen/skill/SKILL.md");
	mkdirSync(dirname(source), { recursive: true });
	writeFileSync(source, "fixture skill\n");
	const script = join(tempDir, "scripts/prepare-bun-compile-assets.mjs");
	mkdirSync(dirname(script), { recursive: true });
	writeFileSync(script, readFileSync(new URL("./prepare-bun-compile-assets.mjs", import.meta.url)));
	// When
	const result = spawnSync(process.execPath, [script], { cwd: join(tempDir, "packages/coding-agent"), encoding: "utf8", timeout: 10_000 });
	// Then
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(readFileSync(join(tempDir, "packages/coding-agent/dist/core/extensions/builtin/imagegen/skill/SKILL.md")), readFileSync(source));
});

it("leaves legacy dependency files untouched when preparing imagegen assets", () => {
	// Given: stale installs must not be patched by the retired compile workaround.
	tempDir = mkdtempSync(join(tmpdir(), "senpi-retired-assets-"));
	const source = join(tempDir, "node_modules/css-tree/lib/data-patch.js");
	mkdirSync(dirname(source), { recursive: true });
	writeFileSync(source, "export default 42;\n");
	const patch = join(tempDir, "node_modules/css-tree/data/patch.json");
	mkdirSync(dirname(patch), { recursive: true });
	writeFileSync(patch, JSON.stringify({ properties: { fixture: { syntax: "<number>" } } }));
	const skill = join(tempDir, "packages/coding-agent/src/core/extensions/builtin/imagegen/skill/SKILL.md");
	mkdirSync(dirname(skill), { recursive: true });
	writeFileSync(skill, "fixture skill\n");
	const before = readFileSync(source);
	// When
	const result = spawnSync(process.execPath, [new URL("./prepare-bun-compile-assets.mjs", import.meta.url).pathname], {
		cwd: tempDir, encoding: "utf8", timeout: 10_000, env: { ...process.env, PI_BUN_COMPILE_REPO_ROOT: tempDir },
	});
	// Then
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(readFileSync(source), before);
});
