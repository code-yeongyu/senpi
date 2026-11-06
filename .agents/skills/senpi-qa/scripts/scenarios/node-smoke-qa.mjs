#!/usr/bin/env node
// Z1.n Node equivalence smoke (plan D1.4, P0-05b): the real CLI runs open, send, resume and compact once per runtime
// against the fake model server, through the persisted RpcClient; the runs' normalized O1 (provider request bodies), O2
// (provider/model/route) and O7 (persisted transcript) must be identical. Every run records its `child_runtime`.
//
//   node .agents/skills/senpi-qa/scripts/scenarios/node-smoke-qa.mjs --compare --runtimes node,bun --evidence node-smoke
//
// Each runtime runs in its own driver process (`--run-one`), because a driver resolves its child runtime once from its
// own argv (lib/common.mjs). Exit code 0 only when every pair of runs is identical.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startCaseRun } from "../../scenarios/fused-equivalence/cases/support/case-run.mjs";
import { writeCodemodeSettings } from "../../scenarios/fused-equivalence/cases/support/codemode.mjs";
import { observe } from "../../scenarios/fused-equivalence/cases/support/observe.mjs";
import { ownTsxCache } from "../../scenarios/fused-equivalence/cases/support/tsx-cache.mjs";
import { childRuntime, evidenceDir, guardRealAuth, installCleanupHooks } from "../lib/common.mjs";
import { diffNormalized } from "../lib/equivalence-normalize.mjs";
import { RUNTIME_GATED, unmatchedGatedRemovals, withoutRuntimeGated } from "../lib/node-smoke-gating.mjs";

const OBSERVABLES = ["O1", "O2", "O7"];
// The runtime-gated parts removed before comparing live in lib/node-smoke-gating.mjs (with their unit test).
const RUNTIMES = new Set(["node", "bun"]);
const argv = process.argv.slice(2);
const value = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);

/** One smoke run on this driver's child runtime: open, send, resume, compact. */
async function runOne(outFile) {
	installCleanupHooks();
	const run = await startCaseRun({
		label: "node-smoke",
		settings: { compaction: { keepRecentTokens: 1 } },
		turns: [{ text: "SMOKE-FIRST" }, { text: "SMOKE-SECOND" }, { text: "SMOKE-SUMMARY of the conversation" }],
	});
	try {
		// The js kernel stays on in both runs; the runtime description it gives the model is stripped in RUNTIME_GATED.
		writeCodemodeSettings(run.box.cwd, {});
		await run.open();
		await run.prompt("first");
		await run.close();
		await run.open({ resume: true });
		await run.prompt("second");
		await run.send({ type: "compact" });
		await run.close();
		await run.reopenState();
		const observations = observe(run, OBSERVABLES);
		writeFileSync(outFile, `${JSON.stringify({ child_runtime: childRuntime().label, observations }, null, 1)}\n`);
	} finally {
		await run.stop();
		run.box.cleanup();
	}
}

function driver(runtime, outFile) {
	const self = fileURLToPath(import.meta.url);
	const args = [self, "--run-one", outFile, ...(runtime === "node" ? ["--child", "node"] : [])];
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, args, { stdio: ["ignore", "inherit", "inherit"] });
		child.once("close", (code) =>
			code === 0 ? resolve() : reject(new Error(`${runtime} smoke run exited ${code}`)),
		);
	});
}

async function compare() {
	// The Node runs' CLI children run through the tsx CLI; the comparing process owns their cache for the whole step.
	const releaseTsxCache = ownTsxCache();
	try {
		await compareRuntimes();
	} finally {
		releaseTsxCache();
	}
}

async function compareRuntimes() {
	const guard = guardRealAuth();
	const runtimes = (value("--runtimes") ?? "node,bun").split(",");
	if (runtimes.length < 2 || runtimes.some((runtime) => !RUNTIMES.has(runtime)))
		throw new Error("--runtimes takes two or more of node,bun");
	const slug = value("--evidence") ?? "node-smoke";
	const out = evidenceDir(slug);
	const runs = [];
	for (const runtime of runtimes) {
		const file = join(out, `${runtime}.observed.json`);
		await driver(runtime, file);
		runs.push({ runtime, ...JSON.parse(readFileSync(file, "utf8")) });
	}
	const runtimeGated = {};
	for (const run of runs) {
		const patterns = RUNTIME_GATED[run.runtime];
		const counts = Object.fromEntries(patterns.map(([name]) => [name, 0]));
		run.observations = withoutRuntimeGated(run.observations, patterns, counts);
		runtimeGated[run.runtime] = counts;
	}
	const [base, ...others] = runs;
	const comparisons = others.map((other) => ({
		pair: `${base.runtime}-vs-${other.runtime}`,
		diffs: diffNormalized(base.observations, other.observations),
	}));
	guard.assertUnchanged();
	for (const run of runs) process.stdout.write(`child_runtime ${run.runtime}: ${run.child_runtime}\n`);
	process.stdout.write(
		`runtime-gated (bun skill, kernel runtime line; removed before comparing): ${JSON.stringify(runtimeGated)}\n`,
	);
	const unmatched = runs.length > 1 ? unmatchedGatedRemovals(runtimeGated) : [];
	if (unmatched.length > 0)
		process.stdout.write(
			`[FAIL] runtime-gated difference(s) matched nothing, so lib/node-smoke-gating.mjs is stale: ${unmatched.join(", ")}\n`,
		);
	for (const { pair, diffs } of comparisons) {
		process.stdout.write(
			`[${diffs.length === 0 ? "PASS" : "FAIL"}] ${pair}: ${diffs.length} difference(s) in ${OBSERVABLES.join(", ")}\n`,
		);
		for (const row of diffs.slice(0, 12))
			process.stdout.write(
				`    ${row.path}: ${JSON.stringify(row.golden)?.slice(0, 160)} vs ${JSON.stringify(row.actual)?.slice(0, 160)}\n`,
			);
	}
	const receipt = {
		command: `node .agents/skills/senpi-qa/scripts/scenarios/node-smoke-qa.mjs ${argv.join(" ")}`,
		runs: runs.map(({ runtime, child_runtime }) => ({ runtime, child_runtime })),
		runtimeGated,
		comparisons,
	};
	writeFileSync(join(out, "receipt.json"), `${JSON.stringify(receipt, null, 1)}\n`);
	process.stdout.write(`evidence: ${out}\n`);
	process.exitCode = unmatched.length === 0 && comparisons.every((c) => c.diffs.length === 0) ? 0 : 1;
}

const main = argv.includes("--run-one")
	? () => runOne(value("--run-one"))
	: argv.includes("--compare")
		? compare
		: undefined;
if (!main) throw new Error("pass --compare (or --run-one <file>, used internally)");
main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exitCode = 2;
});
