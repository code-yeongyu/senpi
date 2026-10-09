#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { binaryIdentity, repository, runRecorded, stageReadRuntime } from "./read-summary-build.mjs";
import { readSummaryControl, readSummaryGrammarControl, readSurface } from "./read-summary-parity.mjs";

const { values } = parseArgs({ options: { binary: { type: "string" }, out: { type: "string" } }, strict: true });
assert(values.binary && isAbsolute(values.binary));
assert(values.out && isAbsolute(values.out));
const directory = dirname(values.out);
mkdirSync(directory, { recursive: true });
const startedAt = new Date().toISOString();
try {
	const control = readSummaryControl();
	const files = [
		readSummaryGrammarControl(),
		control,
		{ ...control, id: "typescript-raw", path: "typescript.ts" },
		{ ...control, id: "unsupported", path: "unsupported.rs" },
	];
	const sourceDirectory = mkdtempSync(join(directory, "source-"));
	const binaryDirectory = mkdtempSync(join(directory, "binary-"));
	const sourceLayout = stageReadRuntime(sourceDirectory);
	const binaryLayout = stageReadRuntime(binaryDirectory, values.binary);
	const versionSmoke = runRecorded([...binaryLayout.command, "--version"], binaryDirectory, `${values.out}.version.json`);
	const source = await readSurface(sourceLayout.command, sourceDirectory, files);
	const binary = await readSurface(binaryLayout.command, binaryDirectory, files);
	assert.deepEqual(binary.records, source.records);
	assert.deepEqual(binary.fresh, source.fresh);
	// The compiled binary must reach its embedded grammar, not fall back to the scan it defeats.
	assert(source.records[0].elided.length > 0);
	assert(binary.records[0].elided.length > 0);
	assert(source.records[1].elided.length > 0);
	assert.deepEqual(source.records[2].elided, []);
	assert.deepEqual(source.records[3].elided, []);
	writeFileSync(
		values.out,
		`${JSON.stringify(
			{
				passed: true,
				head_sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
				versionSmoke,
				startedAt,
				finishedAt: new Date().toISOString(),
				platform: process.platform,
				arch: process.arch,
				artifact: binaryIdentity(values.binary),
				source,
				binary,
				paidProviderCalls: 0,
			},
			null,
			2,
		)}\n`,
	);
	console.log(JSON.stringify({ passed: true, out: values.out }));
} catch (error) {
	writeFileSync(
		`${values.out}.error.json`,
		`${JSON.stringify({ passed: false, startedAt, error: error instanceof Error ? error.stack : String(error) }, null, 2)}\n`,
	);
	throw error;
}
