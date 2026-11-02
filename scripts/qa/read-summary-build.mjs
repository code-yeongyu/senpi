#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parse } from "shell-quote";
import { measureReadSummaryBinaryDelta } from "../prepare-bun-compile-assets.mjs";

/** Consume the shell recipe reached by Build Binaries, not the different package build:binary mode. */
export function releaseCompileArgs(root, output) {
	const script = readFileSync(join(root, "scripts/build-binaries.sh"), "utf8").replace(/\\\r?\n/g, " ");
	const commands = script.split("\n").filter((line) => /^\s*bun build --compile\b/.test(line));
	assert.equal(commands.length, 2, "Expected both publishing platform compile contracts");
	const contracts = commands.map((command) => {
		const tokens = parse(command, (name) => `$${name}`);
		assert(tokens.every((token) => typeof token === "string"), "Release compile must be a single argv");
		const argv = tokens.filter((token) => !token.startsWith("--target="));
		const outfile = argv.indexOf("--outfile");
		assert(outfile >= 0 && outfile + 1 < argv.length, "Release compile must name its output");
		argv[outfile + 1] = resolve(output);
		return argv;
	});
	assert.deepEqual(contracts[0], contracts[1], "Publishing platform compile contracts diverge");
	return contracts[0];
}
export const binaryTargets = Object.freeze([
	"darwin-arm64",
	"darwin-x64",
	"linux-x64",
	"linux-arm64",
	"windows-x64",
	"windows-arm64",
]);
export const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}
export function binaryIdentity(path) {
	return { path, sha256: sha256(path), bytes: statSync(path).size };
}

export function runRecorded(command, cwd, receipt) {
	const startedAt = new Date().toISOString();
	const result = spawnSync(command[0], command.slice(1), {
		cwd,
		encoding: "utf8",
		timeout: 600000,
		maxBuffer: 32 * 1024 * 1024,
	});
	const record = {
		command,
		cwd,
		startedAt,
		finishedAt: new Date().toISOString(),
		exitCode: result.status,
		signal: result.signal,
		stdout: result.stdout,
		stderr: result.stderr,
		error: result.error?.message,
	};
	mkdirSync(dirname(receipt), { recursive: true });
	writeFileSync(receipt, `${JSON.stringify(record, null, 2)}\n`);
	assert.equal(result.error, undefined, JSON.stringify(record));
	assert.equal(result.status, 0, JSON.stringify(record));
	return record;
}

export function compileBinary(root, output, target) {
	const targetFlags = target ? [`--target=bun-${target}${target.endsWith("-x64") ? "-baseline" : ""}`] : [];
	mkdirSync(dirname(output), { recursive: true });
	return runRecorded(
		[...releaseCompileArgs(root, output), ...targetFlags],
		join(root, "packages/coding-agent"),
		`${output}.build.json`,
	);
}

export function corruptRequiredCompileAsset(path) {
	const original = readFileSync(path, "utf8");
	const corrupted = original.replace('"dark.json"', '"read-summary-required-theme.missing.json"');
	assert.notEqual(corrupted, original, "Expected required packaged theme lookup");
	writeFileSync(path, corrupted);
	return original;
}

export function stageReadRuntime(directory, binary) {
	mkdirSync(directory, { recursive: true });
	const fixture = join(directory, "read-summary-provider.mjs");
	copyFileSync(join(repository, "scripts/qa/fixtures/read-summary-provider.mjs"), fixture);
	if (binary) {
		copyFileSync(binary, join(directory, process.platform === "win32" ? "senpi.exe" : "senpi"));
		// Existing distribution data, not new read/parser assets. No node_modules tree is staged.
		copyFileSync(join(repository, "packages/coding-agent/package.json"), join(directory, "package.json"));
		mkdirSync(join(directory, "theme"));
		const themes = join(repository, "packages/coding-agent/src/modes/interactive/theme");
		for (const name of readdirSync(themes).filter((name) => name.endsWith(".json")))
			copyFileSync(join(themes, name), join(directory, "theme", name));
	}
	return {
		fixture,
		command: binary
			? [join(directory, process.platform === "win32" ? "senpi.exe" : "senpi")]
			: ["bun", join(repository, "packages/coding-agent/src/cli.ts")],
	};
}

export function buildReadBinaries(directory, baselineRoot, ceiling) {
	assert.notEqual(resolve(baselineRoot), repository);
	assert.deepEqual(releaseCompileArgs(baselineRoot, directory), releaseCompileArgs(repository, directory),
		"Baseline and candidate must use identical release entry/flag contracts");
	const commands = [];
	for (const [name, root] of [
		["baseline", baselineRoot],
		["candidate", repository],
	]) {
		commands.push(runRecorded(["bun", "run", "build:bun"], root, join(directory, `${name}-build.json`)));
		commands.push(
			runRecorded(["bun", "scripts/prepare-bun-compile-assets.mjs"], root, join(directory, `${name}-prepare.json`)),
		);
	}
	const candidate = join(directory, "senpi");
	commands.push(compileBinary(repository, candidate));
	const baseline = join(directory, "baseline", "senpi");
	commands.push(compileBinary(baselineRoot, baseline));
	const measurements = [];
	for (const target of binaryTargets) {
		const filename = target.startsWith("windows-") ? "senpi.exe" : "senpi";
		const candidatePath = join(directory, "targets", target, filename);
		const baselinePath = join(directory, "baseline", target, filename);
		commands.push(compileBinary(repository, candidatePath, target));
		commands.push(compileBinary(baselineRoot, baselinePath, target));
		measurements.push({
			target,
			baseline: binaryIdentity(baselinePath),
			candidate: binaryIdentity(candidatePath),
			...measureReadSummaryBinaryDelta({
				baselineBytes: statSync(baselinePath).size,
				candidateBytes: statSync(candidatePath).size,
				maxDeltaBytes: ceiling,
			}),
		});
	}
	const runtimeDirectory = join(directory, "runtime");
	const runtime = stageReadRuntime(runtimeDirectory, candidate);
	const versionSmoke = runRecorded([...runtime.command, "--version"], runtimeDirectory, join(directory, "version-smoke.json"));
	return {
		commands,
		measurements,
		runtime: { directory: runtimeDirectory, command: runtime.command, versionSmoke },
		binary: binaryIdentity(candidate),
		baseline: binaryIdentity(baseline),
		hostDelta: measureReadSummaryBinaryDelta({
			baselineBytes: statSync(baseline).size,
			candidateBytes: statSync(candidate).size,
			maxDeltaBytes: ceiling,
		}),
	};
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	const { values } = parseArgs({ options: { out: { type: "string" } }, strict: true });
	assert(values.out, "--out is required");
	compileBinary(repository, resolve(values.out));
}
