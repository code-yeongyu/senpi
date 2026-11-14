#!/usr/bin/env node
/**
 * One forced-suite matrix job (senpi#6642, `.github/workflows/publish-npm.yml`):
 *
 *   node scripts/release-forced-test-part.mjs --part <rest|1..N> --tested-sha <sha> --out-dir <dir>
 *
 * `rest` runs what the in-job forced suite runs serially (`test:scripts`, then every workspace but coding-agent);
 * `i` runs coding-agent `--shard=i/N`, N being `FORCED_SHARD_JOBS`. Both go through `runForcedTestSuite`, so CI=1,
 * the supervisor's budget and the wall lines are the in-job suite's. It refuses to run on any commit but the tested
 * one, and always writes the part's result file (tested commit, part, exit, file and test counts), which
 * `release.mjs --tested-sha` requires for every part before it stamps the release.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { FORCED_SUITE_PARTS, writeForcedSuiteResult } from "./release-forced-suite-results.mjs";
import { FORCED_SHARD_JOBS, planForcedTestSuite, runForcedTestSuite } from "./release-forced-test-suite.mjs";
import { resolveWorkspaceDirectories } from "./run-workspaces.mjs";

/**
 * Budget for one part, inside the job's 40-minute timeout after about 10 minutes of install and build. A coding-agent
 * shard runs about 17 min (98.8 min serial on 2026-11-06, over six shards); the rest about 10.
 */
const FORCED_PART_TIMEOUT_MS = 30 * 60_000;

/**
 * The steps of one part of the forced suite's plan.
 * @param {{serial: import("./release-forced-test-suite.mjs").Step[], parallel: import("./release-forced-test-suite.mjs").Step[]}} plan
 * @param {string} part `rest`, or a coding-agent shard number 1..N
 */
export function selectForcedTestPart(plan, part) {
	if (part === "rest") return { serial: plan.serial, parallel: [] };
	const shard = Number(part);
	if (!/^\d+$/.test(part) || shard < 1 || shard > plan.parallel.length) {
		throw new Error(`unknown forced-suite part ${JSON.stringify(part)}; expected rest or 1..${plan.parallel.length}`);
	}
	return { serial: [], parallel: [plan.parallel[shard - 1]] };
}

const ANSI = /\u001b\[[0-9;]*m/g;

/** Add a vitest (`Test Files ... (n)`, `Tests ... (n)`) or node:test (`ℹ tests n`, `# tests n`) summary line. */
export function countTestSummary(line, counts) {
	const text = line.replace(ANSI, "");
	const files = text.match(/^\s*Test Files\s.*\((\d+)\)\s*$/);
	if (files) {
		counts.files += Number(files[1]);
		return;
	}
	const tests = text.match(/^\s*Tests\s.*\((\d+)\)\s*$/) ?? text.match(/^(?:ℹ|#) tests (\d+)\s*$/);
	if (tests) counts.tests += Number(tests[1]);
}

async function main() {
	const { values } = parseArgs({
		options: { part: { type: "string" }, "tested-sha": { type: "string" }, "out-dir": { type: "string" } },
	});
	const { part, "tested-sha": testedSha, "out-dir": outDir } = values;
	if (!part || !testedSha || !outDir) throw new Error("--part, --tested-sha and --out-dir are required");
	const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	if (head !== testedSha) {
		throw new Error(`HEAD is ${head.slice(0, 12)}, not the tested commit ${testedSha.slice(0, 12)}; refusing to test anything else`);
	}
	const rootDirectory = process.cwd();
	const plan = planForcedTestSuite({
		rootDirectory,
		workspaces: await resolveWorkspaceDirectories(rootDirectory),
		shards: FORCED_SHARD_JOBS,
	});
	const selected = selectForcedTestPart(plan, part);
	const id = part === "rest" ? "rest" : `coding-agent-${part}`;
	const counts = { files: 0, tests: 0 };
	let exitCode = 0;
	try {
		await runForcedTestSuite({
			plan: selected,
			timeoutMs: FORCED_PART_TIMEOUT_MS,
			observe: (line) => countTestSummary(line, counts),
		});
	} catch (error) {
		exitCode = 1;
		process.stderr.write(`[forced-part] ${id}: ${error instanceof Error ? error.message : String(error)}\n`);
	}
	mkdirSync(outDir, { recursive: true });
	const definition = FORCED_SUITE_PARTS.find((candidate) => candidate.id === id);
	writeForcedSuiteResult(outDir, { testedSha, part: definition, exitCode, ...counts });
	process.stdout.write(`[forced-part] ${id} on ${testedSha.slice(0, 12)}: exit ${exitCode}, ${counts.files} files, ${counts.tests} tests\n`);
	process.exitCode = exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().catch((error) => {
		process.stderr.write(`[forced-part] error: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
