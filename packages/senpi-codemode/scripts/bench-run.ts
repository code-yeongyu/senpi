import { availableParallelism, loadavg } from "node:os";
import { type Static, Type } from "typebox";
import type { PairedBlock, RuntimeStatus, Series } from "./bench-compare.ts";
import { contaminationCeiling, contaminationFailures } from "./bench-contamination.ts";
import { hostIdleSeconds, powerSource } from "./bench-host.ts";
import { type HostSample, sampleHost, startHostSampler, summarizeSamples } from "./bench-sampler.ts";
import { implementedScenarios, plannedScenarios } from "./bench-scenarios.ts";
import { runProcess } from "./bench-target.ts";
import { BenchWorkerError, type RuntimeReport, startWorker } from "./bench-worker.ts";

export const runtimesSchema = Type.Object({
	version: Type.Literal(1),
	required: Type.Array(
		Type.Object({
			id: Type.String(),
			language: Type.Union([Type.Literal("js"), Type.Literal("py"), Type.Literal("rb"), Type.Literal("jl")]),
			jsRuntime: Type.Optional(Type.Union([Type.Literal("bun"), Type.Literal("node")])),
		}),
	),
});

export type RequiredRuntime = Static<typeof runtimesSchema>["required"][number];
export type Side = "base" | "head";

export interface RunPlan {
	readonly targets: Readonly<Record<Side, string>>;
	readonly runtimes: readonly RequiredRuntime[];
	readonly blocks: number;
	readonly reps: number;
	readonly scriptRoot: string;
	readonly env: NodeJS.ProcessEnv;
	readonly log: (line: string) => void;
}

/** `measurements` is the actual measurement order; the scheduler alternates which side goes first per repetition. */
export interface BlockRecord {
	readonly index: number;
	readonly loadavg: readonly number[];
	readonly loadavgEnd: readonly number[];
	readonly power: string;
	readonly idleSeconds: number | null;
	readonly startedAt: string;
	readonly endedAt: string;
	readonly hostSamples: readonly HostSample[];
	readonly measurements: readonly {
		readonly runtimeId: string;
		readonly scenario: string;
		readonly rep: number;
		readonly role: string;
		readonly side: Side;
		readonly loadStart: number;
		readonly loadEnd: number;
	}[];
}

export interface RunResult {
	readonly reps: number;
	readonly blocks: readonly BlockRecord[];
	readonly admissionLoads: readonly number[];
	readonly runtimes: readonly RuntimeStatus[];
	readonly series: readonly Series[];
	readonly reports: Readonly<
		Record<string, readonly { block: number; role: string; side: Side; report: RuntimeReport }[]>
	>;
	readonly failures: readonly string[];
}

const interpreterCommand = { js: "bun", py: "python3", rb: "ruby", jl: "julia" } as const;

async function interpreterAvailable(runtime: RequiredRuntime, env: NodeJS.ProcessEnv): Promise<boolean> {
	const command = runtime.jsRuntime ?? interpreterCommand[runtime.language];
	const result = await runProcess([command, "--version"], { cwd: process.cwd(), env }).catch(() => undefined);
	return result?.exitCode === 0;
}

type Collected = Record<string, { block: number; role: string; side: Side; report: RuntimeReport }[]>;

export async function runBlocks(plan: RunPlan): Promise<RunResult> {
	const failures: string[] = [];
	const available = new Map<string, boolean>();
	for (const runtime of plan.runtimes) available.set(runtime.id, await interpreterAvailable(runtime, plan.env));
	const collected: Collected = {};
	const blocks: BlockRecord[] = [];
	const admissionLoads: number[] = [];
	if ([...available.values()].some((present) => !present))
		return {
			reps: plan.reps,
			blocks,
			admissionLoads,
			failures,
			reports: collected,
			...assemble(plan, available, collected),
		};
	blocksLoop: for (let index = 0; index < plan.blocks; index += 1) {
		const startedAt = new Date().toISOString();
		const sampler = startHostSampler(sampleHost);
		const startLoad = loadavg();
		const power = await powerSource();
		const idleSeconds = await hostIdleSeconds();
		plan.log(`block ${index + 1}/${plan.blocks} start ${startedAt}: load ${startLoad.map((value) => value.toFixed(2)).join(" ")}, idle ${idleSeconds ?? "n/a"} s, ${power}`);
		const measurements: Array<BlockRecord["measurements"][number]> = [];
		for (const runtime of plan.runtimes) {
			if (available.get(runtime.id) !== true) continue;
			const runs: { role: string; side: Side }[] = [
				{ role: "comparison", side: "base" },
				{ role: "comparison", side: "head" },
				{ role: "calibration-1", side: "base" },
				{ role: "calibration-2", side: "base" },
			];
			const workers = runs.map((run) => ({ ...run, worker: startWorker(plan, runtime, plan.targets[run.side]) }));
			const reports = new Map<(typeof workers)[number], RuntimeReport>();
			try {
				for (const scenario of implementedScenarios) {
					plan.log(`block ${index + 1}/${plan.blocks} ${runtime.id} ${scenario.name}`);
					for (let rep = -1; rep < plan.reps; rep += 1) {
						const order = (index + rep) % 2 === 0 ? workers : [...workers].reverse();
						for (const run of order) {
							const loadStart = loadavg()[0] ?? 0;
							admissionLoads.push(loadStart);
							if (loadStart > 80)
								throw new BenchWorkerError("host load exceeded 80 before the next measurement");
							const outcome = await run.worker.next();
							const loadEnd = loadavg()[0] ?? 0;
							admissionLoads.push(loadEnd);
							measurements.push({
								runtimeId: runtime.id,
								scenario: scenario.name,
								rep,
								role: run.role,
								side: run.side,
								loadStart,
								loadEnd,
							});
							if (outcome.scenarios[scenario.name]?.length !== (rep < 0 ? 0 : 1))
								throw new BenchWorkerError(`unexpected repetition for ${scenario.name}`);
							const previous = reports.get(run);
							if (
								previous &&
								(previous.runtimeVersion !== outcome.runtimeVersion ||
									previous.hostRuntime !== outcome.hostRuntime ||
									previous.hostVersion !== outcome.hostVersion)
							)
								throw new BenchWorkerError("runtime version changed during measurement");
							const scenarios = previous?.scenarios ?? {};
							for (const [name, samples] of Object.entries(outcome.scenarios))
								(scenarios[name] ??= []).push(...samples);
							reports.set(run, { ...outcome, scenarios });
						}
					}
				}
				for (const [run, report] of reports)
					(collected[runtime.id] ??= []).push({ block: index, role: run.role, side: run.side, report });
			} catch (error) {
				if (!(error instanceof BenchWorkerError)) throw error;
				failures.push(`${runtime.id} block ${index + 1}: ${error.message}`);
			} finally {
				await Promise.all(
					workers.map(({ worker }) =>
						worker.close().catch((error: unknown) => {
							if (!(error instanceof Error)) throw error;
							failures.push(`${runtime.id} cleanup: ${error.message}`);
						}),
					),
				);
			}
			if (failures.length > 0) {
				blocks.push({
					index,
					loadavg: startLoad,
					loadavgEnd: loadavg(),
					power,
					idleSeconds,
					startedAt,
					endedAt: new Date().toISOString(),
					hostSamples: await sampler.stop(),
					measurements,
				});
				break blocksLoop;
			}
		}
		const endedAt = new Date().toISOString();
		const hostSamples = await sampler.stop();
		const loadavgEnd = loadavg();
		blocks.push({
			index,
			loadavg: startLoad,
			loadavgEnd,
			power,
			idleSeconds,
			startedAt,
			endedAt,
			hostSamples,
			measurements,
		});
		plan.log(`block ${index + 1} host: ${startedAt} -> ${endedAt}, ${summarizeSamples(hostSamples)}`);
	}
	failures.push(...contaminationFailures(blocks, contaminationCeiling(availableParallelism())));
	return {
		reps: plan.reps,
		blocks,
		admissionLoads,
		failures,
		reports: collected,
		...assemble(plan, available, collected),
	};
}

function versionOf(runs: readonly { report: RuntimeReport }[]): string | undefined {
	const versions = new Set(
		runs.map(({ report }) => `${report.runtimeVersion} (${report.hostRuntime} ${report.hostVersion})`),
	);
	return versions.size === 1 ? [...versions][0] : versions.size === 0 ? undefined : [...versions].join(" | ");
}

function assemble(plan: RunPlan, available: ReadonlyMap<string, boolean>, collected: Collected) {
	const runtimes: RuntimeStatus[] = [];
	const series: Series[] = [];
	for (const runtime of plan.runtimes) {
		const runs = collected[runtime.id] ?? [];
		const sideRuns = (side: Side) => runs.filter((run) => run.side === side);
		const status = (side: Side) => {
			const version = versionOf(sideRuns(side));
			return {
				available: available.get(runtime.id) === true && sideRuns(side).length > 0,
				...(version ? { version } : {}),
			};
		};
		runtimes.push({ id: runtime.id, base: status("base"), head: status("head") });
		const scenarios = [...implementedScenarios.map((scenario) => scenario.name), ...plannedScenarios];
		for (const scenario of scenarios) {
			const has = (side: Side) =>
				sideRuns(side).length > 0 && sideRuns(side).every((run) => scenario in run.report.scenarios);
			const reps = (block: number, role: string, side: Side) =>
				runs.find((run) => run.block === block && run.role === role && run.side === side)?.report.scenarios[
					scenario
				] ?? [];
			const paired = (roles: readonly [string, Side, string, Side]): PairedBlock[] =>
				Array.from({ length: plan.blocks }, (_, block) => ({
					first: reps(block, roles[0], roles[1]),
					second: reps(block, roles[2], roles[3]),
				}));
			series.push({
				scenario,
				runtimeId: runtime.id,
				optional: plannedScenarios.includes(scenario),
				present: { base: has("base"), head: has("head") },
				calibration: paired(["calibration-1", "base", "calibration-2", "base"]),
				comparison: paired(["comparison", "base", "comparison", "head"]),
			});
		}
	}
	return { runtimes, series };
}
