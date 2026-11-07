#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RESULTS_PER_LINE } from "./vitest-dot-reporters.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const reportersUrl = new URL("./vitest-dot-reporters.mjs", import.meta.url).href;
const vitestEntry = join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs");
// `gh run view --log` stops at the first log line longer than this (Go's bufio.Scanner limit, senpi#2291).
const GH_LOG_LINE_LIMIT = 64 * 1024;

// senpi#2291: run a real Vitest suite off a TTY, as the release job does, and read every line it printed.
test("the dot reporters end a line every RESULTS_PER_LINE results, so no log line grows with the suite", () => {
	const root = mkdtempSync(join(tmpdir(), "vitest-dot-reporters-"));
	try {
		const tests = RESULTS_PER_LINE * 30 + 7;
		writeFileSync(
			join(root, "vitest.config.mjs"),
			`import { dotReporters } from ${JSON.stringify(reportersUrl)};\n` +
				"export default { test: { globals: true, reporters: dotReporters() } };\n",
		);
		writeFileSync(
			join(root, "many.test.mjs"),
			`test.each(Array.from({ length: ${tests} }, (_, i) => i))("case %i", () => {});\n`,
		);
		const env = { ...process.env, FORCE_COLOR: "1" };
		delete env.GITHUB_ACTIONS;
		const result = spawnSync(process.execPath, [vitestEntry, "run", "--root", root], {
			cwd: root,
			env,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 60_000,
		});
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		const lines = result.stdout.split("\n");
		assert.equal(result.stdout.split("·").length - 1, tests, "every passed test still prints its dot");
		const dotLines = lines.filter((line) => line.includes("·"));
		assert.equal(dotLines.length, Math.ceil(tests / RESULTS_PER_LINE));
		for (const line of dotLines) assert.ok(line.split("·").length - 1 <= RESULTS_PER_LINE, line);
		const longest = Math.max(...lines.map((line) => Buffer.byteLength(line)));
		assert.ok(longest < GH_LOG_LINE_LIMIT / 16, `longest line is ${longest} bytes`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("no workspace Vitest config names the built-in dot reporter, which prints the whole run on one line", () => {
	const configs = globSync(["packages/*/vitest*.config.ts", "packages/*/*/vitest*.config.ts"], { cwd: repoRoot });
	assert.ok(configs.includes("packages/ai/vitest.config.ts"));
	const offenders = configs.filter((path) =>
		/reporters\s*:[^\n]*["']dot["']/.test(readFileSync(join(repoRoot, path), "utf8")),
	);
	assert.deepEqual(offenders, []);
});
