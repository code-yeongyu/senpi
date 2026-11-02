#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const ciWorkflow = parse(readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8"));

// Resolve oxfmt from node_modules rather than through a package-manager runner,
// so the gate is exercised identically under npm, bun and pnpm.
const oxfmtPackagePath = createRequire(import.meta.url).resolve("oxfmt/package.json");
const oxfmtPackage = JSON.parse(readFileSync(oxfmtPackagePath, "utf8"));
const oxfmtBin = join(
	dirname(oxfmtPackagePath),
	typeof oxfmtPackage.bin === "string" ? oxfmtPackage.bin : oxfmtPackage.bin.oxfmt,
);

const staticCheckRun = (() => {
	const job = Object.values(ciWorkflow.jobs).find((candidate) => candidate?.name === "Static checks");
	assert.ok(job, "ci.yml must define a job named \"Static checks\"");
	return (job.steps ?? []).map((step) => step.run).filter((run) => typeof run === "string");
})();

const checkScript = () => {
	const invoked = staticCheckRun.find((run) => /npm run check\b/.test(run));
	assert.ok(invoked, `Static checks job must run an npm check script. Steps: ${JSON.stringify(staticCheckRun)}`);
	const script = packageJson.scripts[invoked.trim().replace(/^npm run /, "")];
	assert.ok(script, `missing package script for "${invoked}"`);
	return script;
};

const formatCheckScript = () => {
	const name = checkScript().match(/npm run (fmt[^\s&]*)/)?.[1];
	assert.ok(name, `CI check script must run a fmt script: ${checkScript()}`);
	const script = packageJson.scripts[name];
	assert.ok(script, `missing package script "${name}"`);
	return script;
};

describe("CI format gate", () => {
	it("runs an oxfmt form that reports drift instead of rewriting it", () => {
		// Given: the format script the Static checks job's check script runs.
		const script = formatCheckScript();

		// Then: it is oxfmt in check mode, or the gate can never fail.
		assert.match(script, /^oxfmt\b/, `CI format script must invoke oxfmt: ${script}`);
		assert.match(script, /--check\b/, `CI oxfmt invocation must report drift: ${script}`);
		assert.doesNotMatch(script, /--write\b/, `CI oxfmt invocation rewrites files: ${script}`);
	});

	it("fails on unformatted input with the CI oxfmt invocation", (t) => {
		// Given: a drifted file under a path .oxfmtrc.json actually includes.
		const fixture = mkdtempSync(join(root, "packages", "coding-agent", "src", "ci-format-gate-fixture-"));
		t.after(() => rmSync(fixture, { recursive: true, force: true }));
		const drifted = join(fixture, "drifted.ts");
		writeFileSync(drifted, "export const value   =    1;\n");
		const flags = formatCheckScript()
			.replace(/^oxfmt/, "")
			.trim()
			.split(/\s+/)
			.filter((flag) => flag.startsWith("-"));

		// When: the CI script's own oxfmt argv runs against the drifted file.
		const result = spawnSync(process.execPath, [oxfmtBin, ...flags, drifted], {
			cwd: root,
			timeout: 60000,
			encoding: "utf8",
		});

		// Then: oxfmt saw the file, reported the drift as a failure, and left it untouched.
		assert.match(result.stdout + result.stderr, /drifted\.ts/);
		assert.equal(result.status, 1, `expected drift to fail. stdout: ${result.stdout}\nstderr: ${result.stderr}`);
		assert.equal(readFileSync(drifted, "utf8"), "export const value   =    1;\n");
	});

	it("keeps an explicit autofix script for local use", () => {
		const fixScript = packageJson.scripts["check:fix"];
		assert.ok(fixScript, "expected a check:fix script for local autofix");
		assert.match(fixScript, /npm run fmt(?![:\w])/);
		assert.equal(packageJson.scripts.fmt, "oxfmt");
	});
});
