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

const OBSERVABLES = ["O1", "O2", "O7"];
/**
 * The two designed Node/Bun differences in today's prompt, removed per runtime before the comparison; every removal is
 * counted in the receipt and nothing else is touched:
 * - senpi-codemode contributes its bun-1-4 skill only when the process itself runs on Bun >= 1.4
 *   (packages/senpi-codemode/src/extension/skill-contribution.ts activeBunSkillPath): that skill root and skill entry;
 * - the eval tool's description carries one line naming the runtime its js kernel runs on (`JS runs under Node.js
 *   worker: ...` / `JS runs in-process on Bun <version>: ...`): that one line, on each runtime.
 */
const RUNTIME_GATED = {
	bun: [
		["removedSkillRoots", /\n {2}<r(\d+)><repo>\/packages\/senpi-codemode\/src\/skill<\/r\1>/g],
		[
			"removedSkillEntries",
			/\n {2}<skill>\n {4}<name>bun-1-4<\/name>\n {4}<description>[^<]*<\/description>\n {4}<location>r\d+\/bun-1-4\/SKILL\.md<\/location>\n {2}<\/skill>/g,
		],
		["removedKernelRuntimeLines", /\nJS runs in-process on Bun \d+\.\d+\.\d+: [^\n]*/g],
	],
	node: [["removedKernelRuntimeLines", /\nJS runs under Node\.js worker: [^\n]*/g]],
};

function withoutRuntimeGated(value, patterns, counts) {
	if (typeof value === "string") {
		return patterns.reduce((text, [name, pattern]) => {
			const matches = text.match(pattern)?.length ?? 0;
			counts[name] += matches;
			return matches ? text.replace(pattern, "") : text;
		}, value);
	}
	if (Array.isArray(value)) return value.map((item) => withoutRuntimeGated(item, patterns, counts));
	if (value && typeof value === "object")
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutRuntimeGated(v, patterns, counts)]));
	return value;
}
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
		`runtime-gated (bun-1-4 skill, kernel runtime line; removed before comparing): ${JSON.stringify(runtimeGated)}\n`,
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
	process.exitCode = comparisons.every((c) => c.diffs.length === 0) ? 0 : 1;
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
