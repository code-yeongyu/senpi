#!/usr/bin/env node
// EQ.perf (plan P0-05f, §6.5, obligation Z1.d): fused tool-call dispatch latency through the real CLI on the Bun child,
// over the E01 (3 parallel reads), E02 (sequential tools) and E04 (order-once + hooks) workloads.
//
//   record B0:  node .agents/skills/senpi-qa/scripts/scenarios/fused-latency-qa.mjs --record --runs 10 \
//                 --baseline <latency-baseline.json> [--iterations 10] --evidence <slug>
//   candidate:  node .agents/skills/senpi-qa/scripts/scenarios/fused-latency-qa.mjs --compare \
//                 --baseline <latency-baseline.json> [--runs N] --evidence <slug>
//   plumbing:   node .agents/skills/senpi-qa/scripts/scenarios/fused-latency-qa.mjs --self-test
//
// Every timestamp is taken in this process when a fake-server barrier is reached:
// - `perf-call-<i>`: the provider turn carrying the tool calls is held until reached; its release is the tool-call event;
// - `perf-next-<i>`: the next provider request (the turn after the batch) reached the server;
// - `perf-start:<id>` / `perf-end:<id>`: a wrapper the driver writes around the case's own fixture extension pings
//   these as the tool body is entered and left. The fixtures themselves are loaded unmodified.
// Every barrier is released the moment it is reached, so nothing is held. Time is the behavior under test here (§3.4).
//
// TUI frame time (the second half of §6.5) needs the EQ.tui capture of P0-05c; until it lands the metric is reported
// DEFERRED(P0-05c) and is never counted as passed. Exit: 0 in band, 1 out of band, 2 refused or broken.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { FIXTURES, startCaseRun } from "../../scenarios/fused-equivalence/cases/support/case-run.mjs";
import { HELD_TOOLS } from "../../scenarios/fused-equivalence/cases/support/held.mjs";
import { baselineManifest } from "../../scenarios/fused-equivalence/cases/support/observe.mjs";
import { childRuntime, evidenceDir, guardRealAuth, installCleanupHooks, repoRoot, resolveBun } from "../lib/common.mjs";
import {
	bandOf,
	barrierClock,
	calibrate,
	compareToBand,
	machineClass,
	minOfRuns,
	runMetrics,
	wrapExtension,
} from "../lib/latency-measure.mjs";

/** The metric whose producer has not landed (seam): P0-05c's EQ.tui capture supplies the frame samples. */
const DEFERRED = { tui_frame_ms: "P0-05c" };
const E04 = join(FIXTURES, "e04");

/** The three workloads, each the shape of its EQ case (same tools, same fixtures), repeated `iterations` times. */
const WORKLOADS = [
	{
		id: "E01",
		extensions: [{ wrap: HELD_TOOLS }],
		files: { "a.txt": "alpha\n", "b.txt": "bravo\n", "c.txt": "charlie\n" },
		calls: (i) =>
			["a", "b", "c"].map((x) => ({
				id: `call_${x}_${i}`,
				name: "eq_read",
				args: { path: `${x}.txt`, barrier: `e01-${i}-${x}` },
			})),
	},
	{
		id: "E02",
		sequential: true,
		extensions: [{ wrap: HELD_TOOLS }],
		files: { "out/.keep": "" },
		calls: (i) =>
			[1, 2, 3].map((n) => ({
				id: `seq_${n}_${i}`,
				name: "eq_seq",
				args: { path: `out/seq-${n}-${i}.txt`, text: `seq_${n}\n`, barrier: `e02-${i}-${n}` },
			})),
	},
	{
		id: "E04",
		extensions: [{ wrap: join(E04, "qa-extension.mjs") }, join(E04, "block-extension.mjs")],
		calls: (i) => [
			{ id: `g1-run-${i}`, name: "qa", args: { legacy: "42" } },
			{ id: `g1-block-${i}`, name: "qa", args: { legacy: "7" } },
		],
		// hook2 blocks the second call, so only the first body runs.
		ran: (calls) => [calls[0].id],
		setup: writeE04Hooks,
	},
];

function parseArgs(argv) {
	const value = (flag) => {
		const index = argv.indexOf(flag);
		return index >= 0 ? argv[index + 1] : undefined;
	};
	const count = (flag) => {
		const raw = value(flag);
		const parsed = raw === undefined ? undefined : Number.parseInt(raw, 10);
		if (raw !== undefined && !(Number.isInteger(parsed) && parsed > 0))
			throw new Error(`${flag} must be a positive integer`);
		return parsed;
	};
	const mode = ["--record", "--compare", "--self-test"].find((flag) => argv.includes(flag))?.slice(2);
	if (!mode) throw new Error("pass --record, --compare or --self-test");
	const surface = value("--surface");
	if (surface === "tui")
		throw new Error(`--surface tui is DEFERRED(${DEFERRED.tui_frame_ms}): its capture has not landed`);
	if (surface !== undefined) throw new Error(`unknown --surface ${surface}`);
	const baseline = value("--baseline");
	if (mode !== "self-test" && !baseline) throw new Error(`--${mode} needs --baseline <file>`);
	return { mode, baseline, runs: count("--runs"), iterations: count("--iterations"), evidence: value("--evidence") };
}

/** E04's trusted shell PreToolUse/PostToolUse hooks, written exactly as the E04 case writes them. */
function writeE04Hooks(run) {
	const hook = join(E04, "shell-hook.mjs");
	const trace = join(run.box.cwd, "trace.log");
	const command = (kind) =>
		`${JSON.stringify(process.execPath)} ${JSON.stringify(hook)} ${kind} ${JSON.stringify(trace)}`;
	const args = [join(E04, "write-hooks.ts"), run.box.cwd, command("pre"), command("post")];
	const setup = spawnSync(resolveBun().command, args, { encoding: "utf8" });
	if (setup.status !== 0) throw new Error(`write-hooks.ts failed: ${setup.stderr}`);
}

async function iterate(run, clock, workload, i) {
	const calls = workload.calls(i);
	const ran = workload.ran?.(calls) ?? calls.map((call) => call.id);
	const held = calls.map((call) => call.args.barrier).filter(Boolean);
	clock.arm([
		`perf-call-${i}`,
		`perf-next-${i}`,
		...held,
		...ran.flatMap((id) => [`perf-start:${id}`, `perf-end:${id}`]),
	]);
	await run.prompt(`${workload.id} iteration ${i}`);
	const callAt = clock.read(`perf-call-${i}`);
	const bodies = [];
	for (const id of ran) {
		// A sequential successor can start only once the previous body ended; that is its ready time.
		const readyAt = workload.sequential && bodies.length ? bodies.at(-1).endAt : callAt;
		bodies.push({ id, readyAt, startAt: clock.read(`perf-start:${id}`), endAt: clock.read(`perf-end:${id}`) });
	}
	return { callAt, nextAt: clock.read(`perf-next-${i}`), bodies };
}

/**
 * Open a fresh CLI for the workload. A loaded disk can stall a child's first file opens past the open timeout before
 * any sample exists; such an open is retried once on a fresh sandbox and counted. Nothing measured is ever retried.
 */
async function openWorkload(workload, turns, retries) {
	for (let attempt = 1; ; attempt++) {
		const run = await startCaseRun({ label: `perf-${workload.id.toLowerCase()}`, turns, files: workload.files });
		try {
			for (const extension of workload.extensions)
				run.args.push(
					"--extension",
					typeof extension === "string" ? extension : wrapExtension(run.box.dir, extension.wrap),
				);
			workload.setup?.(run);
			await run.open();
			return run;
		} catch (error) {
			if (run.client) await run.kill();
			await run.stop();
			run.box.cleanup();
			if (attempt > 1) throw error;
			retries.push({ workload: workload.id, error: String(error).split("\n")[0] });
			process.stdout.write(
				`open of ${workload.id} failed before any sample; retrying once: ${retries.at(-1).error}\n`,
			);
		}
	}
}

async function measureWorkload(workload, iterations, retries) {
	const turns = [];
	for (let i = 0; i < iterations; i++)
		turns.push(
			{ holdUntil: `perf-call-${i}`, toolCalls: workload.calls(i) },
			{ holdUntil: `perf-next-${i}`, text: `${workload.id}-DONE-${i}` },
		);
	const run = await openWorkload(workload, turns, retries);
	try {
		const clock = barrierClock(run);
		const out = [];
		for (let i = 0; i < iterations; i++) out.push(await iterate(run, clock, workload, i));
		return out;
	} finally {
		await run.stop();
		run.box.cleanup();
	}
}

async function measureRuns(count, iterations) {
	const runs = [];
	for (let index = 0; index < count; index++) {
		const calibration_ms = calibrate();
		const loadavg = os.loadavg().map((load) => Math.round(load * 100) / 100);
		const workloads = {};
		const open_retries = [];
		for (const workload of WORKLOADS)
			workloads[workload.id] = await measureWorkload(workload, iterations, open_retries);
		runs.push({ metrics: runMetrics(workloads), calibration_ms, loadavg, open_retries });
		process.stdout.write(`run ${index + 1}/${count}: calibration ${calibration_ms} ms, load ${loadavg.join(" ")}\n`);
	}
	return runs;
}

const sha256 = (path) => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;

function printMetrics(metrics, band) {
	for (const [name, value] of Object.entries(metrics)) {
		const limit = band?.[name];
		const above = limit && (value.p50 > limit.p50.max || value.p95 > limit.p95.max);
		const tag = limit ? (above ? "FAIL" : "PASS") : "INFO";
		const bound = (q) => (limit ? ` (B0 ${limit[q].min}..${limit[q].max})` : "");
		process.stdout.write(`[${tag}] ${name} p50=${value.p50}${bound("p50")} p95=${value.p95}${bound("p95")}\n`);
	}
	for (const [name, owner] of Object.entries(DEFERRED))
		process.stdout.write(`[DEFERRED] ${name}: DEFERRED(${owner})\n`);
}

async function main() {
	installCleanupHooks();
	const options = parseArgs(process.argv.slice(2));
	const runtime = childRuntime();
	if (runtime.kind === "node")
		throw new Error("EQ.perf is a positive run: the CLI child runs on Bun or the binary (N32)");
	const host = {
		machine_class: machineClass(os.cpus()[0]?.model, os.availableParallelism()),
		child_runtime: runtime.label,
	};
	const command = `node .agents/skills/senpi-qa/scripts/scenarios/fused-latency-qa.mjs ${process.argv.slice(2).join(" ")}`;
	const band = options.mode === "compare" ? JSON.parse(readFileSync(options.baseline, "utf8")) : undefined;
	if (band) {
		for (const key of ["machine_class", "child_runtime"])
			if (host[key] !== band[key]) throw new Error(`not comparable with B0: ${key} ${host[key]} vs B0 ${band[key]}`);
		if (options.iterations && options.iterations !== band.iterations)
			throw new Error(`--iterations ${options.iterations} differs from B0's ${band.iterations}`);
	}
	const iterations = band?.iterations ?? options.iterations ?? (options.mode === "self-test" ? 2 : 10);
	const runCount = options.runs ?? band?.runs_n ?? (options.mode === "self-test" ? 1 : 10);
	const guard = guardRealAuth();
	const runs = await measureRuns(runCount, iterations);
	guard.assertUnchanged();
	const manifest = baselineManifest({ repo: repoRoot(), childRuntime: host.child_runtime, command });
	const harness = {
		driver: sha256(new URL(import.meta.url)),
		measure: sha256(new URL("../lib/latency-measure.mjs", import.meta.url)),
	};
	const receipt = { command, mode: options.mode, ...host, iterations, runs_n: runCount, runs, manifest, harness };
	let exit = 0;
	if (options.mode === "record") {
		Object.assign(receipt, { metrics: bandOf(runs), deferred: DEFERRED });
		writeFileSync(options.baseline, `${JSON.stringify(receipt, null, 1)}\n`);
		for (const [name, b] of Object.entries(receipt.metrics))
			process.stdout.write(`[B0] ${name} p50 ${b.p50.min}..${b.p50.max} p95 ${b.p95.min}..${b.p95.max}\n`);
		process.stdout.write(`B0 band written: ${options.baseline}\n`);
	} else if (options.mode === "compare") {
		const perf = { ...host, metrics: minOfRuns(runs) };
		const findings = compareToBand(perf, band);
		Object.assign(receipt, { baseline: { path: options.baseline, sha256: sha256(options.baseline) } });
		Object.assign(receipt, { perf, perf_in_band: findings.length === 0, findings, deferred: DEFERRED });
		printMetrics(perf.metrics, band.metrics);
		for (const finding of findings) process.stdout.write(`    ${finding.code}: ${finding.detail}\n`);
		exit = findings.length ? 1 : 0;
	} else {
		const metrics = runs[0].metrics;
		const broken = Object.entries(metrics).filter(([, m]) => !(m.n > 0 && m.p50 >= 0 && m.p95 >= m.p50));
		printMetrics(metrics);
		for (const [name] of broken) process.stdout.write(`    broken metric: ${name}\n`);
		exit = broken.length || Object.keys(metrics).length !== 8 ? 1 : 0;
	}
	process.stdout.write(
		`\nfused-latency-qa ${options.mode}: ${exit === 0 ? "PASS" : "FAIL"} (machine_class=${host.machine_class} child_runtime=${host.child_runtime} runs=${runCount} iterations=${iterations})\n`,
	);
	if (options.evidence) {
		const out = evidenceDir(options.evidence);
		writeFileSync(join(out, "receipt.json"), `${JSON.stringify(receipt, null, 1)}\n`);
		process.stdout.write(`evidence: ${out}\n`);
	}
	process.exitCode = exit;
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exitCode = 2;
});
