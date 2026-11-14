#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { resolveBunExecutable, supportsFmt } from "./bun-fmt.mjs";

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

// The wrapper used to spawn bare `bun` through `shell: true` on win32, so a
// forwarded path containing spaces was split by cmd.exe before it reached
// bun (senpi#5599). It now resolves bun to an absolute path and spawns it
// without a shell on every platform.
describe("bun fmt wrapper resolves bun without a shell", () => {
	it("prefers bun.exe over the PATHEXT shims on win32", () => {
		// Given: a win32 PATH whose first entry holds both a real bun.exe
		// and a bun.cmd shim.
		const exists = (candidate) => candidate === "C:\\tools\\bun.exe" || candidate === "C:\\tools\\bun.cmd";

		// When: the wrapper resolves bun for win32.
		const resolved = resolveBunExecutable({ platform: "win32", pathEnv: "C:\\tools;C:\\other", exists });

		// Then: the real binary wins, so the shim can never shadow it.
		assert.equal(resolved, "C:\\tools\\bun.exe");
	});

	it("falls back to a bun.cmd shim on win32 when no bun.exe exists", () => {
		// Given: a win32 PATH with only a bun.cmd shim.
		const exists = (candidate) => candidate === "C:\\tools\\bun.cmd";

		// When: the wrapper resolves bun for win32.
		const resolved = resolveBunExecutable({ platform: "win32", pathEnv: "C:\\tools", exists });

		// Then: the shim is used rather than failing outright.
		assert.equal(resolved, "C:\\tools\\bun.cmd");
	});

	it("returns null when no bun is on PATH", () => {
		// Given: PATH entries with no bun in any of them.
		const exists = () => false;

		// When: the wrapper resolves bun.
		const resolved = resolveBunExecutable({ platform: "win32", pathEnv: "C:\\tools", exists });

		// Then: the caller falls back to bare `bun` and reports the miss.
		assert.equal(resolved, null);
	});

	it("resolves a bare bun on posix", () => {
		// Given: a posix PATH whose first entry holds an executable bun.
		const exists = (candidate) => candidate === "/opt/bun/bin/bun";

		// When: the wrapper resolves bun for posix.
		const resolved = resolveBunExecutable({ platform: "linux", pathEnv: "/opt/bun/bin:/usr/bin", exists });

		// Then: the bare name resolves with no extension search.
		assert.equal(resolved, "/opt/bun/bin/bun");
	});

	it("passes a path containing spaces to bun as one argument", (t) => {
		// Given: a fake bun on PATH that records the argv it receives, and
		// a file under a directory whose name contains spaces.
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "bun-fmt-spaced-")));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		const binDir = join(dir, "bin");
		mkdirSync(binDir, { recursive: true });
		const record = join(dir, "argv.jsonl");
		const fakeBun = join(binDir, "bun");
		writeFileSync(
			fakeBun,
			`#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nconst argv = process.argv.slice(2);\nif (argv[0] === "--version") {\n\tconsole.log("1.4.4");\n} else {\n\tappendFileSync(${JSON.stringify(record)}, JSON.stringify(argv) + "\\n");\n}\n`,
		);
		chmodSync(fakeBun, 0o755);
		const spacedDir = join(dir, "path with spaces");
		mkdirSync(spacedDir, { recursive: true });
		const spacedFile = join(spacedDir, "probe.ts");
		writeFileSync(spacedFile, "export const value = 1;\n");

		// When: the wrapper checks the spaced file.
		const result = spawnSync(process.execPath, [fmtWrapper, "--check", spacedFile], {
			env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
			timeout: 60000,
			encoding: "utf8",
		});

		// Then: the fake bun ran, and it saw the spaced path as one argument.
		assert.equal(result.status, 0, `expected the check to pass. stdout: ${result.stdout}\nstderr: ${result.stderr}`);
		const recorded = JSON.parse(readFileSync(record, "utf8").trim());
		assert.equal(
			recorded.filter((arg) => arg.includes("path with spaces")).length,
			1,
			`spaced path must arrive as one argument: ${JSON.stringify(recorded)}`,
		);
		assert.ok(recorded.includes(spacedFile), `expected argv to carry ${spacedFile}: ${JSON.stringify(recorded)}`);
	});
});
