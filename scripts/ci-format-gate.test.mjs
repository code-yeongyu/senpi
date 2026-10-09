#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const ciWorkflow = parse(readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8"));

// Resolve biome from node_modules rather than through a package-manager runner,
// so the gate is exercised identically under npm, bun and pnpm.
const binDir = join(dirname(createRequire(import.meta.url).resolve("@biomejs/biome/package.json")), "bin");

const staticCheckRun = (() => {
	const job = Object.values(ciWorkflow.jobs).find((candidate) => candidate?.name === "Static checks");
	assert.ok(job, "ci.yml must define a job named \"Static checks\"");
	return (job.steps ?? []).map((step) => step.run).filter((run) => typeof run === "string");
})();

describe("CI format gate", () => {
	it("runs a biome form that reports drift instead of rewriting it", () => {
		// Given: the script the Static checks job actually invokes.
		const invoked = staticCheckRun.find((run) => /npm run check\b/.test(run));
		assert.ok(invoked, `Static checks job must run an npm check script. Steps: ${JSON.stringify(staticCheckRun)}`);
		const script = packageJson.scripts[invoked.trim().replace(/^npm run /, "")];
		assert.ok(script, `missing package script for "${invoked}"`);

		// Then: its biome invocation must not autofix, or the gate can never fail.
		const biomeInvocation = script.match(/biome check[^&]*/)?.[0] ?? "";
		assert.ok(biomeInvocation, `CI check script must invoke biome: ${script}`);
		assert.doesNotMatch(
			biomeInvocation,
			/--write|--fix/,
			`CI biome invocation rewrites files and exits 0 on drift: ${biomeInvocation}`,
		);
	});

	it("fails on unformatted input with the CI biome invocation", (t) => {
		// Given: a drifted file under a path biome.json actually includes.
		const fixture = mkdtempSync(join(root, "packages", "coding-agent", "src", "ci-format-gate-fixture-"));
		t.after(() => rmSync(fixture, { recursive: true, force: true }));
		const drifted = join(fixture, "drifted.ts");
		writeFileSync(drifted, "export const value   =    1;\n");
		const invoked = staticCheckRun.find((run) => /npm run check\b/.test(run)) ?? "";
		const script = packageJson.scripts[invoked.trim().replace(/^npm run /, "")] ?? "";
		const flags = (script.match(/biome check[^&]*/)?.[0] ?? "")
			.replace(/^biome check/, "")
			.trim()
			.split(/\s+/)
			.filter((flag) => flag.startsWith("-"));

		// When: the CI script's own biome argv runs against the drifted file.
		const result = spawnSync("biome", ["check", ...flags, drifted], {
			cwd: root,
			timeout: 60000,
			encoding: "utf8",
			shell: process.platform === "win32",
			env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` },
		});

		// Then: biome saw the file, reported the drift as a failure, and left it untouched.
		assert.doesNotMatch(result.stdout + result.stderr, /No files were processed/);
		assert.equal(result.status, 1, `expected drift to fail. stdout: ${result.stdout}\nstderr: ${result.stderr}`);
		assert.equal(readFileSync(drifted, "utf8"), "export const value   =    1;\n");
	});

	it("keeps an explicit autofix script for local use", () => {
		const fixScript = packageJson.scripts["check:fix"];
		assert.ok(fixScript, "expected a check:fix script for local autofix");
		assert.match(fixScript, /biome check[^&]*--write/);
	});
});
