#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: { "probe-files": { type: "string", default: "5000" } },
});
const probeFiles = Number(values["probe-files"]);
if (positionals.length !== 1 || !Number.isSafeInteger(probeFiles) || probeFiles < 1) {
	console.error("usage: probe-native-grep.mjs <native.node> [--probe-files N] (N must be a positive integer)");
	process.exit(2);
}

const require = createRequire(import.meta.url);
const native = require(resolve(positionals[0]));
const sentinel = typeof native.__senpiGrepAbi1 === "function" ? native.__senpiGrepAbi1() : undefined;
assert.equal(sentinel, "1", "sentinel mismatch: expected __senpiGrepAbi1() === '1'");
assert.equal(typeof native.grep, "function", "native binding missing grep()");

const root = mkdtempSync(join(tmpdir(), "senpi-native-grep-probe-"));
try {
	const corpus = join(root, "corpus");
	mkdirSync(corpus);
	// Deliberately create in reverse order: results must be path ordered.
	const names = ["z.txt", "m.txt", "a.txt"];
	for (const name of names) writeFileSync(join(corpus, name), "needle\n");
	const options = { pattern: "needle", paths: [corpus], cwd: corpus, mode: "content" };
	const result = await native.grep(options);
	assert.equal(result.matches.length, 3);
	assert.deepEqual(result.matches.map((match) => match.path), ["a.txt", "m.txt", "z.txt"]);
	assert.equal(result.timedOut, false);

	const controller = new AbortController();
	controller.abort();
	await assert.rejects(native.grep(options, controller.signal), { code: "ABORTED" });

	const large = join(root, "timeout-corpus");
	mkdirSync(large);
	for (let i = 0; i < probeFiles; i++) {
		writeFileSync(join(large, `${String(i).padStart(8, "0")}.txt`), "needle\n");
	}
	const timeoutResult = await native.grep({ ...options, paths: [large], cwd: large, timeoutMs: 1 });
	assert.equal(typeof timeoutResult.timedOut, "boolean");
	if (timeoutResult.timedOut) {
		assert.equal(timeoutResult.counts.exact, false);
		assert.ok(timeoutResult.warnings.some((warning) => warning.code === "TIMEOUT"));
	} else {
		assert.equal(timeoutResult.matches.length, probeFiles);
		assert.equal(timeoutResult.counts.exact, true);
	}
	console.log(
		`sentinel=${sentinel} matches=${result.matches.length} aborted=ABORTED timeout=${timeoutResult.timedOut ? "timedOut" : "completed"} probeFiles=${probeFiles}`,
	);
} finally {
	rmSync(root, { recursive: true, force: true });
}
