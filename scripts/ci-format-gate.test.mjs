#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { supportsFmt } from "./bun-fmt.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const ciWorkflow = parse(readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8"));

const fmtWrapper = join(root, "scripts", "bun-fmt.mjs");
const FMT_WRAPPER_COMMAND = /^node scripts\/bun-fmt\.mjs\b/;

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

// A copy of .oxfmtrc.json under the OS temp root, so a fixture at packages/coding-agent/src inside it is
// in the formatter's scope; a directory inside the real packages/*/src would race every scripts test that
// walks that tree (#5305).
const fixtureFile = (t, name) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "ci-format-gate-fixture-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	copyFileSync(join(root, ".oxfmtrc.json"), join(dir, ".oxfmtrc.json"));
	const file = join(dir, "packages", "coding-agent", "src", "ci-format-gate-fixture", name);
	mkdirSync(dirname(file), { recursive: true });
	return { dir, file };
};

describe("CI format gate", () => {
	it("keeps its formatter fixtures outside the repository, so no source scan can meet them", (t) => {
		const { dir } = fixtureFile(t, "probe.ts");
		assert.ok(relative(realpathSync(root), dir).startsWith(".."), dir);
	});

	it("runs bun fmt in a form that reports drift instead of rewriting it", () => {
		// Given: the format script the Static checks job's check script runs.
		const script = formatCheckScript();

		// Then: it is the bun fmt wrapper in check mode, or the gate can never fail.
		assert.match(script, FMT_WRAPPER_COMMAND, `CI format script must invoke scripts/bun-fmt.mjs: ${script}`);
		assert.match(script, /--check\b/, `CI bun fmt invocation must report drift: ${script}`);
		assert.doesNotMatch(script, /--write\b/, `CI bun fmt invocation rewrites files: ${script}`);
	});

	it("fails on unformatted input with the CI bun fmt invocation", (t) => {
		// Given: a drifted file under a path .oxfmtrc.json actually includes.
		const { dir, file: drifted } = fixtureFile(t, "drifted.ts");
		writeFileSync(drifted, "export const value   =    1;\n");
		const flags = formatCheckScript()
			.replace(FMT_WRAPPER_COMMAND, "")
			.trim()
			.split(/\s+/)
			.filter((flag) => flag.startsWith("-"));

		// When: the CI script's own argv runs against the drifted file.
		const result = spawnSync(process.execPath, [fmtWrapper, ...flags, drifted], {
			cwd: dir,
			timeout: 60000,
			encoding: "utf8",
		});

		// Then: bun fmt saw the file, reported the drift as a failure, and left it untouched.
		assert.match(result.stdout + result.stderr, /drifted\.ts/);
		assert.equal(result.status, 1, `expected drift to fail. stdout: ${result.stdout}\nstderr: ${result.stderr}`);
		assert.equal(readFileSync(drifted, "utf8"), "export const value   =    1;\n");
	});

	it("passes on formatted input with the CI bun fmt invocation", (t) => {
		// Given: the same fixture path, already formatted.
		const { dir, file: formatted } = fixtureFile(t, "formatted.ts");
		writeFileSync(formatted, "export const value = 1;\n");

		// When: the wrapper checks it.
		const result = spawnSync(process.execPath, [fmtWrapper, "--check", formatted], {
			cwd: dir,
			timeout: 60000,
			encoding: "utf8",
		});

		// Then: the check passes, so a pass is not the wrapper swallowing every result.
		assert.equal(result.status, 0, `expected a clean file to pass. stdout: ${result.stdout}\nstderr: ${result.stderr}`);
	});

	it("refuses a Bun without the fmt command instead of re-entering the fmt script", () => {
		assert.equal(supportsFmt("1.4.4"), true);
		assert.equal(supportsFmt("1.4.5\n"), true);
		assert.equal(supportsFmt("1.5.0"), true);
		assert.equal(supportsFmt("2.0.0"), true);
		assert.equal(supportsFmt("1.4.3"), false);
		assert.equal(supportsFmt("1.3.9"), false);
		assert.equal(supportsFmt("0.9.9"), false);
		assert.equal(supportsFmt("not-a-version"), false);
	});

	it("keeps an explicit autofix script for local use", () => {
		const fixScript = packageJson.scripts["check:fix"];
		assert.ok(fixScript, "expected a check:fix script for local autofix");
		assert.match(fixScript, /npm run fmt(?![:\w])/);
		assert.equal(packageJson.scripts.fmt, "node scripts/bun-fmt.mjs");
	});
});
