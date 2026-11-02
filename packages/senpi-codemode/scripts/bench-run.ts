import { availableParallelism, loadavg } from "node:os";
import { type Static, Type } from "typebox";
import { type BlockAttempt, classifyAttempt, runBlockAttempt } from "./bench-block.ts";
import { LOAD_REFUSAL, type PairedBlock, type RuntimeStatus, type Series } from "./bench-compare.ts";
import { contaminationCeiling, contaminationFailures } from "./bench-contamination.ts";
import { type HostSample, summarizeSamples } from "./bench-sampler.ts";
import { implementedScenarios, plannedScenarios } from "./bench-scenarios.ts";
import { waitForLoadBelow } from "./bench-settle.ts";
import { runProcess } from "./bench-target.ts";
import type { RuntimeReport } from "./bench-worker.ts";

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
	/** Runs before a spiked block is retried, given the load to wait for; defaults to `waitForLoadBelow` (senpi#2909). */
	readonly settle?: (target: number) => Promise<void>;
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
	/** Blocks re-run after a host-load spike over the refusal ceiling, with the attempt that was kept (senpi#2909). */
	readonly retriedBlocks: readonly { readonly block: number; readonly attempts: number }[];
}

/** Re-runs of one block after a load spike before it is labelled instead of kept (senpi#2909). */
export const SPIKE_RETRIES = 3;

/**
 * The load a retry waits for: back to the host's last load from before the spike (the pre-run load, then each kept
 * block's start load) plus the 1-minute average's jitter, or the contamination ceiling if that is higher. The
 * discarded attempt's own start load is not used: a spike already under way when the block began would set the
 * target above the spike and end the wait at once. The ceiling alone never settles on a host whose normal load is
 * above it (senpi#2909). The target is capped 10 under the refusal ceiling, so a calm level near 80 cannot set a target
 * a retry would start into (senpi#2922).
 */
export function settleTarget(calmLoad: number): number {
	return Math.min(SETTLE_CAP, Math.max(contaminationCeiling(availableParallelism()), calmLoad + SETTLE_JITTER));
}

/** A retry never starts at or near the refusal ceiling it would immediately cross again (senpi#2922). */
const SETTLE_CAP = LOAD_REFUSAL - 10;

const SETTLE_JITTER = 5;

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
	const retriedBlocks: { block: number; attempts: number }[] = [];
	const settle =
		plan.settle ??
		(async (target: number) => {
			await waitForLoadBelow(target, { log: plan.log });
		});
	if ([...available.values()].some((present) => !present))
		return {
			reps: plan.reps,
			blocks,
			admissionLoads,
			failures,
			reports: collected,
			retriedBlocks,
			...assemble(plan, available, collected),
		};
	// The last load known to be from before any spike: the pre-run load, then each kept block's start load.
	let calmLoad = loadavg()[0] ?? 0;
	for (let index = 0; index < plan.blocks; index += 1) {
		const peaks: number[] = [];
		let kept: BlockAttempt | undefined;
		for (let attempt = 0; attempt <= SPIKE_RETRIES; attempt += 1) {
			const tried = await runBlockAttempt(plan, index, available);
			const outcome = classifyAttempt(tried);
			if (outcome.kind !== "spiked") {
				kept = tried;
				break;
			}
			const { peak } = outcome;
			peaks.push(peak);
			plan.log(`block ${index + 1}/${plan.blocks} discarded: host load spike ${peak.toFixed(2)} > ${LOAD_REFUSAL}`);
			if (attempt < SPIKE_RETRIES) await settle(settleTarget(calmLoad));
		}
		if (peaks.length > 0 && kept) retriedBlocks.push({ block: index, attempts: peaks.length + 1 });
		if (!kept) {
			failures.push(
				`host load spike in block ${index + 1}: discarded after ${peaks.length} attempts (peaks ${peaks.map((peak) => peak.toFixed(2)).join(", ")} > ${LOAD_REFUSAL})`,
			);
			continue;
		}
		calmLoad = kept.record.loadavg[0] ?? calmLoad;
		admissionLoads.push(...kept.loads);
		for (const { runtimeId, ...entry } of kept.reports) (collected[runtimeId] ??= []).push(entry);
		blocks.push(kept.record);
		if (kept.failures.length > 0) {
			failures.push(...kept.failures);
			break;
		}
		plan.log(`block ${index + 1} host: ${kept.record.startedAt} -> ${kept.record.endedAt}, ${summarizeSamples(kept.record.hostSamples)}`);
	}
	failures.push(...contaminationFailures(blocks, contaminationCeiling(availableParallelism())));
	return {
		reps: plan.reps,
		blocks,
		admissionLoads,
		failures,
		reports: collected,
		retriedBlocks,
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
