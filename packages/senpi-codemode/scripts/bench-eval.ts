import { readFile, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Check } from "typebox/value";
import { admitHost, type Decision, decide } from "./bench-compare.ts";
import {
	injectCalibrationOffset,
	injectSlow,
	parseInjection,
	type SlowInjection,
	unmatchedInjections,
} from "./bench-inject.ts";
import { loadSavedReport, RescoreError } from "./bench-rescore.ts";
import { type RunResult, runBlocks, runtimesSchema, type Side } from "./bench-run.ts";
import type { Series } from "./bench-compare.ts";
import { assertFreshTarget, BenchTargetError, resolvePackage, targetRevision } from "./bench-target.ts";
import { type BandScope, DEFAULT_BAND_SCOPE, MAX_BAND, parseBandScope, THRESHOLD_Z } from "./bench-threshold.ts";
import { MIN_REPS } from "./bench-validate.ts";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptRoot, "..");

function benchEnv(): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_")));
}

function refused(line: string): Decision {
	return {
		exitCode: 2,
		verdict: "REFUSED",
		bandScope: DEFAULT_BAND_SCOPE,
		lines: [line],
		results: [],
		skipped: [],
	};
}

function noInjectionTarget(unmatched: readonly string[]): string {
	return `--inject-slow ${unmatched.join(", ")} matches no series measured on both sides; refusing a vacuous injection`;
}

const fixed = (value: number) => (Number.isFinite(value) ? value.toFixed(3) : String(value));

function printDecision(decision: Decision, out: string): void {
	console.log(
		`A/A bands (${decision.bandScope} scope): gate = trimmed-mean paired ratio <= 1.00 + band; band = |A/A offset| + ${THRESHOLD_Z} SE, threshold capped at ${MAX_BAND.toFixed(2)}; a row whose band exceeds the cap is NOISE-LIMITED (INCONCLUSIVE); MDE = band, the smallest slowdown the row can detect`,
	);
	console.log("  row | threshold | band | MDE | ratio | median paired ratio | verdict");
	for (const result of decision.results) {
		console.log(
			`  ${result.scenario} ${result.runtimeId} ${result.metric} | ${fixed(result.threshold)} | ${fixed(result.band)} | ${fixed(result.mde)} | ${fixed(result.ratio)} | ${fixed(result.medianPairedRatio)} | ${result.verdict}${result.headBudget === undefined ? "" : " (head budget)"}`,
		);
	}
	const count = (verdict: string) => decision.results.filter((result) => result.verdict === verdict).length;
	console.log(
		`rows: ${count("PASS")} PASS, ${count("NOISE-LIMITED")} NOISE-LIMITED, ${count("FAIL")} FAIL of ${decision.results.length}`,
	);
	for (const skip of decision.skipped) console.log(`  skipped ${skip}`);
	for (const line of decision.lines) console.error(line);
	console.log(`Bench report: ${out}`);
	console.log(`bench: ${decision.verdict} (exit ${decision.exitCode})`);
}

async function main(): Promise<number> {
	const { values } = parseArgs({
		options: {
			base: { type: "string" },
			head: { type: "string" },
			blocks: { type: "string", default: "3" },
			reps: { type: "string", default: "15" },
			"band-scope": { type: "string", default: DEFAULT_BAND_SCOPE },
			out: { type: "string", default: "bench-report.json" },
			runtimes: { type: "string" },
			"inject-slow": { type: "string", multiple: true, default: [] },
			"inject-loadavg": { type: "string" },
			"inject-aa-offset": { type: "string", default: "1" },
			rescore: { type: "string" },
		},
	});
	const out = resolve(values.out);
	const bandScope = parseBandScope(values["band-scope"]);
	const injections = values["inject-slow"].map(parseInjection);
	const calibrationOffset = Number(values["inject-aa-offset"]);
	const injected = (series: readonly Series[]) =>
		series.map((entry) => injectCalibrationOffset(injectSlow(entry, injections), calibrationOffset));
	if (values.rescore !== undefined)
		return rescore(resolve(values.rescore), out, { bandScope, injections, calibrationOffset, injected });
	const load = values["inject-loadavg"] === undefined ? (loadavg()[0] ?? 0) : Number(values["inject-loadavg"]);
	console.log(`host: 1-minute load ${load.toFixed(2)}, ${process.platform}/${process.arch}`);
	const admission = admitHost(load);
	if (admission) return finish(admission, out, {});
	if (!values.base || !values.head) throw new RangeError("bench needs --base <checkout> and --head <checkout>");
	const targets = { base: resolvePackage(values.base), head: resolvePackage(values.head) };
	const revisions: Partial<Record<Side, string>> = {};
	for (const side of ["base", "head"] as const) {
		try {
			await assertFreshTarget(targets[side]);
			revisions[side] = await targetRevision(targets[side]);
		} catch (error) {
			if (error instanceof BenchTargetError) return finish(refused(`${side}: ${error.message}`), out, { targets });
			throw error;
		}
	}
	const manifest: unknown = JSON.parse(await readFile(resolve(packageRoot, "test/gate/runtimes.json"), "utf8"));
	if (!Check(runtimesSchema, manifest)) throw new RangeError("test/gate/runtimes.json does not match its schema");
	const subset = values.runtimes?.split(",");
	const runtimes = manifest.required.filter((runtime) => subset === undefined || subset.includes(runtime.id));
	if (subset?.some((id) => !manifest.required.some((runtime) => runtime.id === id)) || runtimes.length === 0)
		throw new RangeError("--runtimes must select known, nonempty runtime ids");
	if (subset !== undefined)
		console.log(`runtime subset (explicit --runtimes): ${runtimes.map((r) => r.id).join(", ")}`);
	const blocks = Number(values.blocks);
	const reps = Number(values.reps);
	if (!Number.isInteger(blocks) || blocks < 3 || !Number.isInteger(reps) || reps < MIN_REPS)
		throw new RangeError(`bench requires at least three blocks and at least ${MIN_REPS} repetitions per side`);
	const run = await runBlocks({
		targets,
		runtimes,
		blocks,
		reps,
		scriptRoot,
		env: benchEnv(),
		log: (line) => console.log(line),
	});
	const blockLoads = [
		...run.admissionLoads,
		...run.blocks.map((block) => block.loadavg[0] ?? 0),
		...Object.values(run.reports).flatMap((reports) => reports.map(({ report }) => report.loadavg[0] ?? 0)),
	];
	const unmatched = unmatchedInjections(run.series, injections);
	// The raw samples are kept un-injected, so the refused measurement can still be rescored.
	if (unmatched.length > 0)
		return finish(refused(noInjectionTarget(unmatched)), out, {
			targets,
			revisions,
			blocks,
			reps,
			blockLoads,
			injections: [],
			refusedInjections: injections,
			run,
			series: run.series,
		});
	const series = injected(run.series);
	const decision = decide({ runtimes: run.runtimes, reps, bandScope, blockLoads, series, failures: run.failures });
	const context = { targets, revisions, blocks, reps, bandScope, injections, calibrationOffset, blockLoads };
	return finish(decision, out, { ...context, run, series });
}

interface Rescoring {
	readonly bandScope: BandScope;
	readonly injections: readonly SlowInjection[];
	readonly calibrationOffset: number;
	readonly injected: (series: readonly Series[]) => Series[];
}

/** Re-judges a saved measurement: same comparator, no new samples, so scope and fault injections cost no host time. */
async function rescore(source: string, out: string, options: Rescoring): Promise<number> {
	const saved = await loadSavedReport(source).catch((error: unknown) => {
		if (error instanceof RescoreError) return error;
		throw error;
	});
	if (saved instanceof RescoreError) return finish(refused(saved.message), out, { rescoredFrom: source });
	const { bandScope, injections, calibrationOffset } = options;
	const unmatched = unmatchedInjections(saved.series, injections);
	if (unmatched.length > 0)
		return finish(refused(noInjectionTarget(unmatched)), out, { rescoredFrom: source, injections });
	const series = options.injected(saved.series);
	const decision = decide({ ...saved, bandScope, series });
	console.log(`rescored ${source} (${saved.reps} repetitions per side; no new samples)`);
	return finish(decision, out, {
		rescoredFrom: source,
		reps: saved.reps,
		bandScope,
		injections,
		calibrationOffset,
		blockLoads: saved.blockLoads,
		failures: saved.failures,
		runtimes: saved.runtimes,
		series,
	});
}

async function finish(decision: Decision, out: string, context: Readonly<Record<string, unknown>>): Promise<number> {
	const { run, ...rest } = context;
	const runResult: RunResult | undefined = isRunResult(run) ? run : undefined;
	const report = {
		schemaVersion: 1,
		suite: "senpi-codemode-eval",
		package: "@code-yeongyu/senpi-codemode",
		createdAt: new Date().toISOString(),
		policy:
			`paired interleaved repetitions, trimmed mean (25%) of paired log ratios per row <= 1.00 + A/A band; band = |A/A offset| + ${THRESHOLD_Z} SE of that row's calibration pairs (or the largest row band for every row with --band-scope global), threshold capped at ${MAX_BAND}; per-row MDE = band; noise-limited and host-contaminated runs inconclusive`,
		...rest,
		hostLoadavg: loadavg(),
		hostRuntime: {
			bun: process.versions.bun,
			node: process.versions.node,
			platform: process.platform,
			arch: process.arch,
		},
		...(runResult === undefined
			? {}
			: {
					blocks: runResult.blocks,
					admissionLoads: runResult.admissionLoads,
					retriedBlocks: runResult.retriedBlocks,
					runtimes: runResult.runtimes,
					failures: runResult.failures,
					reports: runResult.reports,
				}),
		decision,
	};
	await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
	printDecision(decision, out);
	return decision.exitCode;
}

function isRunResult(value: unknown): value is RunResult {
	return typeof value === "object" && value !== null && "series" in value && "blocks" in value;
}

main().then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 3;
	},
);
