import { loadavg } from "node:os";
import { LOAD_REFUSAL } from "./bench-compare.ts";
import { hostIdleSeconds, powerSource } from "./bench-host.ts";
import { sampleHost, startHostSampler } from "./bench-sampler.ts";
import { implementedScenarios } from "./bench-scenarios.ts";
import type { BlockRecord, RunPlan, Side } from "./bench-run.ts";
import { BenchWorkerError, type RuntimeReport, startWorker } from "./bench-worker.ts";

export interface BlockReport {
	readonly runtimeId: string;
	readonly block: number;
	readonly role: string;
	readonly side: Side;
	readonly report: RuntimeReport;
}

/**
 * One try at a block (senpi#2909). `spikePeak` is set when any 1-minute load the attempt saw went over the refusal
 * ceiling; such an attempt is discarded whole, so none of its data reaches the series or the host-refusal check.
 */
export interface BlockAttempt {
	readonly record: BlockRecord;
	readonly reports: readonly BlockReport[];
	readonly loads: readonly number[];
	readonly failures: readonly string[];
	readonly spikePeak: number | undefined;
}

/**
 * A worker failure outranks a spike: the attempt ends the run with its failures kept, so a runtime crash can never be
 * discarded together with a spike and turn into a passing run (senpi#2909).
 */
export type AttemptOutcome = { readonly kind: "failed" | "kept" } | { readonly kind: "spiked"; readonly peak: number };

export function classifyAttempt(attempt: Pick<BlockAttempt, "failures" | "spikePeak">): AttemptOutcome {
	if (attempt.failures.length > 0) return { kind: "failed" };
	return attempt.spikePeak === undefined ? { kind: "kept" } : { kind: "spiked", peak: attempt.spikePeak };
}

class HostLoadSpike extends Error {
	readonly peak: number;

	constructor(peak: number) {
		super(`host load ${peak.toFixed(2)} > ${LOAD_REFUSAL}`);
		this.peak = peak;
	}
}

const spiked = (load: number): boolean => load > LOAD_REFUSAL;

export async function runBlockAttempt(
	plan: RunPlan,
	index: number,
	available: ReadonlyMap<string, boolean>,
): Promise<BlockAttempt> {
	const startedAt = new Date().toISOString();
	const sampler = startHostSampler(sampleHost);
	const startLoad = loadavg();
	const power = await powerSource();
	const idleSeconds = await hostIdleSeconds();
	plan.log(
		`block ${index + 1}/${plan.blocks} start ${startedAt}: load ${startLoad.map((value) => value.toFixed(2)).join(" ")}, idle ${idleSeconds ?? "n/a"} s, ${power}`,
	);
	const measurements: Array<BlockRecord["measurements"][number]> = [];
	const reports: BlockReport[] = [];
	const loads: number[] = [];
	const failures: string[] = [];
	let spikePeak = spiked(startLoad[0] ?? 0) ? (startLoad[0] ?? 0) : undefined;
	for (const runtime of plan.runtimes) {
		if (spikePeak !== undefined || failures.length > 0) break;
		if (available.get(runtime.id) !== true) continue;
		const runs: { role: string; side: Side }[] = [
			{ role: "comparison", side: "base" },
			{ role: "comparison", side: "head" },
			{ role: "calibration-1", side: "base" },
			{ role: "calibration-2", side: "base" },
		];
		const workers = runs.map((run) => ({ ...run, worker: startWorker(plan, runtime, plan.targets[run.side]) }));
		const collected = new Map<(typeof workers)[number], RuntimeReport>();
		try {
			for (const scenario of implementedScenarios) {
				plan.log(`block ${index + 1}/${plan.blocks} ${runtime.id} ${scenario.name}`);
				for (let rep = -1; rep < plan.reps; rep += 1) {
					const order = (index + rep) % 2 === 0 ? workers : [...workers].reverse();
					for (const run of order) {
						const loadStart = loadavg()[0] ?? 0;
						if (spiked(loadStart)) throw new HostLoadSpike(loadStart);
						loads.push(loadStart);
						const outcome = await run.worker.next();
						const loadEnd = loadavg()[0] ?? 0;
						if (spiked(loadEnd)) throw new HostLoadSpike(loadEnd);
						loads.push(loadEnd);
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
						const previous = collected.get(run);
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
						collected.set(run, { ...outcome, scenarios });
					}
				}
			}
			for (const [run, report] of collected) {
				const reportLoad = report.loadavg[0] ?? 0;
				if (spiked(reportLoad)) throw new HostLoadSpike(reportLoad);
				reports.push({ runtimeId: runtime.id, block: index, role: run.role, side: run.side, report });
			}
		} catch (error) {
			if (error instanceof HostLoadSpike) spikePeak = error.peak;
			else if (error instanceof BenchWorkerError) failures.push(`${runtime.id} block ${index + 1}: ${error.message}`);
			else throw error;
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
	}
	const hostSamples = await sampler.stop();
	const samplePeak = Math.max(0, ...hostSamples.map((sample) => sample.loadavg[0] ?? 0));
	if (spiked(samplePeak)) spikePeak = Math.max(spikePeak ?? 0, samplePeak);
	const record: BlockRecord = {
		index,
		loadavg: startLoad,
		loadavgEnd: loadavg(),
		power,
		idleSeconds,
		startedAt,
		endedAt: new Date().toISOString(),
		hostSamples,
		measurements,
	};
	return { record, reports, loads, failures, spikePeak };
}
