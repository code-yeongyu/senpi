#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { measureReadSummaryBinaryDelta } from "../prepare-bun-compile-assets.mjs";
import {
	binaryIdentity,
	compileBinary,
	corruptRequiredCompileAsset,
	repository,
	sha256,
	stageReadRuntime,
} from "./read-summary-build.mjs";
import { readSurface } from "./read-summary-parity.mjs";
import { isolatedReadEnvironment } from "./read-summary-rpc.mjs";

export async function missingAssetAndBudget(directory, binary, ceiling) {
	// Corrupt a generated compile input, never source: the rebuilt binary asks for a
	// missing required distribution theme during CLI initialization, before any read.
	const asset = realpathSync(join(repository, "packages/coding-agent/dist/modes/interactive/theme/theme.js"));
	assert(!relative(repository, asset).startsWith(".."), "Corruption is limited to this execution-owned installation");
	const beforeHash = sha256(asset);
	const original = readFileSync(asset, "utf8");
	const negativeBinary = join(directory, "missing-asset", "senpi");
	let build;
	try {
		corruptRequiredCompileAsset(asset);
		build = compileBinary(repository, negativeBinary);
	} finally {
		writeFileSync(asset, original);
	}
	assert.equal(sha256(asset), beforeHash);
	const runtime = mkdtempSync(join(directory, "missing-asset-runtime-"));
	const layout = stageReadRuntime(runtime, negativeBinary);
	const command = [
		...layout.command,
		"--mode",
		"rpc",
		"--no-session",
		"--offline",
		"--no-context-files",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"-e",
		layout.fixture,
	];
	const result = spawnSync(command[0], command.slice(1), {
		cwd: runtime,
		env: isolatedReadEnvironment(runtime),
		encoding: "utf8",
		timeout: 60000,
		input: `${JSON.stringify({ id: "initialization", type: "get_state" })}\n`,
		maxBuffer: 4 * 1024 * 1024,
	});
	assert.equal(result.error, undefined, result.error?.message);
	assert.notEqual(result.status, 0, "Broken packaging returned successful initialization");
	assert.match(result.stderr, /ENOENT/);
	assert.match(result.stderr, /read-summary-required-theme\.missing\.json/);
	assert(!result.stdout.includes('"tool_execution_end"'));
	assert(!result.stdout.includes('"success":true'));
	const actual = binaryIdentity(binary);
	const oversizedPath = join(directory, "oversized-senpi");
	copyFileSync(binary, oversizedPath);
	appendFileSync(oversizedPath, Buffer.alloc(ceiling + 1));
	const oversized = binaryIdentity(oversizedPath);
	let budgetRejection;
	try {
		measureReadSummaryBinaryDelta({
			baselineBytes: actual.bytes,
			candidateBytes: oversized.bytes,
			maxDeltaBytes: ceiling,
		});
		assert.fail("Oversized candidate was accepted");
	} catch (error) {
		assert.equal(error.code, "READ_SUMMARY_BINARY_BUDGET_EXCEEDED");
		budgetRejection = {
			code: error.code,
			baselineBytes: error.baselineBytes,
			candidateBytes: error.candidateBytes,
			deltaBytes: error.deltaBytes,
			maxDeltaBytes: error.maxDeltaBytes,
		};
	}
	// Bad source remains normal raw output on the good binary; packaging errors never become raw.
	const healthy = mkdtempSync(join(directory, "bad-source-runtime-"));
	const healthyLayout = stageReadRuntime(healthy, binary);
	const content = JSON.stringify({ groups: Array.from({ length: 30 }, (_, value) => ({ value, label: "control" })) }, null, 2).slice(0, -1);
	assert.throws(() => JSON.parse(content), SyntaxError);
	assert(content.split("\n").length >= 100 && Buffer.byteLength(content) < 51200);
	const files = [
		{ id: "malformed-json", path: "malformed.json", content },
		{ id: "unsupported-rust", path: "unsupported.rs", content },
	];
	const fallback = await readSurface(healthyLayout.command, healthy, files);
	assert.equal(fallback.records[0].full.identity.selection.languages.json, "heuristic");
	for (const row of fallback.records) {
		assert.deepEqual(row.elided, []);
		assert.equal(row.full.results[0].result.content[0].text, content);
	}
	return {
		build,
		binary: binaryIdentity(negativeBinary),
		missingAsset: {
			command,
			cwd: runtime,
			exitCode: result.status,
			stdout: result.stdout,
			stderr: result.stderr,
			originalPreparedAssetSha256: beforeHash,
		},
		budgetRejection: { ...budgetRejection, oversized },
		malformedSourceFallback: fallback,
	};
}
