#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parse } from "shell-quote";
import { parse as parseYaml } from "yaml";
import { releaseCompileArgs, repository } from "./qa/read-summary-build.mjs";

test("QA compiles the publishing workflow's shell recipe (#1639)", () => {
	const workflow = parseYaml(readFileSync(join(repository, ".github/workflows/build-binaries.yml"), "utf8"));
	const build = workflow.jobs.build.steps.find((step) => step.name === "Build binaries");
	const [script] = parse(build.run);
	const commands = readFileSync(join(repository, script), "utf8").split("\n").filter((line) => /^\s*bun build --compile\b/.test(line));
	assert.equal(commands.length, 2);
	const actual = releaseCompileArgs(repository, "output/senpi");
	for (const command of commands) {
		const args = parse(command, (name) => `$${name}`).filter((arg) => !arg.startsWith("--target="));
		args[args.indexOf("--outfile") + 1] = resolve("output/senpi");
		assert.deepEqual(actual, args);
	}
});

test("QA rejects divergent platform flags instead of choosing one publishing branch", () => {
	const root = mkdtempSync(join(tmpdir(), "read-release-divergence-"));
	try {
		mkdirSync(join(root, "scripts"));
		mkdirSync(join(root, "packages/coding-agent"), { recursive: true });
		writeFileSync(join(root, "packages/coding-agent/package.json"), JSON.stringify({ scripts: { "build:binary": "bun build --compile entry.js --outfile out" } }));
		writeFileSync(join(root, "scripts/build-binaries.sh"), 'bun build --compile entry.js --outfile "$OUTPUT_DIR/pi"\nbun build --compile --compile-autoload-package-json entry.js --outfile "$OUTPUT_DIR/pi.exe"\n');
		assert.throws(() => releaseCompileArgs(root, "out"), /platform.*contract/i);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
