#!/usr/bin/env node
// T-D (design #12965, 5.4): the realm census derives the expected root set and fails on any unclassified binding.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(scriptsDir, "..");
const tool = join(scriptsDir, "check-realm-census.mjs");
const fixtures = join(scriptsDir, "fixtures", "realm-census");
const work = mkdtempSync(join(tmpdir(), "realm-census-"));
after(() => rmSync(work, { recursive: true, force: true }));

function census(args) {
	const result = spawnSync(process.execPath, [tool, "--json", ...args], { encoding: "utf8" });
	assert.equal(result.stderr, "");
	return { status: result.status, report: JSON.parse(result.stdout) };
}

/** A copy of the base fixture tree with one case file placed under a root package's src. */
function treeWith(caseFile, bindings = {}) {
	const root = mkdtempSync(join(work, "tree-"));
	cpSync(join(fixtures, "base"), root, { recursive: true });
	if (caseFile) cpSync(join(fixtures, "cases", caseFile), join(root, "packages", "lib", "src", caseFile));
	const tablePath = join(root, "scripts", "realm-census.json");
	const table = JSON.parse(readFileSync(tablePath, "utf8"));
	writeFileSync(tablePath, JSON.stringify({ ...table, bindings }));
	return root;
}

describe("real repository", () => {
	const real = census([]);

	it("(i) the checked-in table classifies every binding in the real roots", () => {
		const { status, report } = real;
		assert.deepEqual(report.problems, []);
		assert.equal(status, 0);
		assert.ok(report.population.length > 0);
	});

	it("(ii) the derived roots equal the checked-in expected list", () => {
		const table = JSON.parse(readFileSync(join(repoRoot, "scripts", "realm-census.json"), "utf8"));
		assert.deepEqual(real.report.roots.derived, table.roots);
	});

	it("(v) M12: dropping senpi-codemode from the derivation fails the expected-list check", () => {
		const { status, report } = census(["--test-drop-root", "senpi-codemode"]);
		assert.equal(status, 1);
		assert.ok(
			report.problems.some((problem) => /^derived roots differ .*table only \[senpi-codemode\]/u.test(problem)),
			report.problems.join("\n"),
		);
	});
});

describe("fixture tree", () => {
	it("derives coding-agent's closure plus engine-owned extensions and their imports, and nothing else", () => {
		const { status, report } = census(["--root", treeWith()]);
		assert.deepEqual(report.roots.derived, ["coding-agent", "extension-dependency", "lib", "senpi-codemode"]);
		assert.deepEqual(report.problems, []);
		assert.equal(status, 0);
	});

	const unclassified = [
		["new Map()", "new-map.ts", "cache"],
		["new AsyncLocalStorage()", "async-local-storage.ts", "scope"],
		["new WeakSet()", "weak-set.ts", "seen"],
		["new SomeClass()", "some-class.ts", "holder"],
		["mutable []", "mutable-array.ts", "pending"],
		["let", "let.ts", "counter"],
		["static class field", "static-field.ts", "Registry.entries"],
	];
	for (const [kind, caseFile, name] of unclassified) {
		it(`(iii) an unclassified ${kind} binding fails and is named`, () => {
			const { status, report } = census(["--root", treeWith(caseFile)]);
			assert.equal(status, 1);
			const key = `packages/lib/src/${caseFile}#${name}`;
			assert.ok(
				report.problems.some((problem) => problem.startsWith(`unclassified binding ${key} `)),
				report.problems.join("\n"),
			);
		});
	}

	it("(iv) an AsyncLocalStorage kept per copy without a ground fails; with ground ii and its split cost it passes", () => {
		const key = "packages/lib/src/async-local-storage.ts#scope";
		const reason = "timing attribution only; a split costs attribution of another copy's work";
		const missing = census([
			"--root",
			treeWith("async-local-storage.ts", { [key]: { class: "per-copy-safe", reason } }),
		]);
		assert.equal(missing.status, 1);
		assert.deepEqual(missing.report.problems, [
			`AsyncLocalStorage ${key} is classified per-copy-safe without "ground": "i" or "ii"`,
		]);
		const grounded = census([
			"--root",
			treeWith("async-local-storage.ts", { [key]: { class: "per-copy-safe", reason, ground: "ii" } }),
		]);
		assert.deepEqual(grounded.report.problems, []);
		assert.equal(grounded.status, 0);
	});

	it("(vi) F4a: a reason cannot turn a registry into a per-copy table, nor a per-copy table into a registry", () => {
		const key = "packages/lib/src/registry.ts#shared";
		const relabelled = census([
			"--root",
			treeWith("registry.ts", { [key]: { class: "per-copy-safe", reason: "a split only loses reuse" } }),
		]);
		assert.equal(relabelled.status, 1);
		assert.deepEqual(relabelled.report.problems, [
			`entry ${key} is initialised by realmRegistry() but classified per-copy-safe`,
		]);
		const honest = census(["--root", treeWith("registry.ts", { [key]: { class: "realm-registry", reason: "x" } })]);
		assert.deepEqual(honest.report.problems, []);

		const mapKey = "packages/lib/src/new-map.ts#cache";
		const claimed = census([
			"--root",
			treeWith("new-map.ts", { [mapKey]: { class: "realm-registry", reason: "claims a registry" } }),
		]);
		assert.equal(claimed.status, 1);
		assert.deepEqual(claimed.report.problems, [
			`entry ${mapKey} is classified realm-registry but its file creates no realm registry`,
		]);
	});

	it("(vii) F4b: a vendored directory is part of the population; a generated one is not", () => {
		const { status, report } = census(["--root", treeWith("vendor/state.ts")]);
		assert.equal(status, 1);
		const key = "packages/lib/src/vendor/state.ts#compiled";
		assert.ok(
			report.problems.some((problem) => problem.startsWith(`unclassified binding ${key} `)),
			report.problems.join("\n"),
		);
		const generated = treeWith();
		const dir = join(generated, "packages", "lib", "src", "gen");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "schema.ts"), "export const registry = new Map<string, number>();\n");
		assert.deepEqual(census(["--root", generated]).report.problems, []);
	});

	it("an entry whose binding is gone is reported stale", () => {
		const key = "packages/lib/src/index.ts#removed";
		const { status, report } = census([
			"--root",
			treeWith(undefined, { [key]: { class: "constant", reason: "gone" } }),
		]);
		assert.equal(status, 1);
		assert.deepEqual(report.problems, [`stale entry ${key} (no such binding in the roots)`]);
	});
});
