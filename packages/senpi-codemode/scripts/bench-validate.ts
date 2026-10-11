import type { BenchInput, Metric, Rep, Series } from "./bench-compare.ts";

export const MIN_REPS = 3;

export function metricsOf(series: Series): Metric[] {
	if (series.scenario === "warm-cell-1000" || series.scenario === "tool-compose-100") return ["cpu", "wall", "p95"];
	const hasP95 = [...series.calibration, ...series.comparison].some((block) =>
		[...block.first, ...block.second].some((rep) => rep.p95Ms !== undefined),
	);
	return hasP95 ? ["cpu", "wall", "p95"] : ["cpu", "wall"];
}

function sampleProblems(series: Series, reps: readonly Rep[]): string[] {
	const label = `${series.scenario} ${series.runtimeId}`;
	const lines: string[] = [];
	for (const rep of reps) {
		if (metricsOf(series).includes("p95") && rep.p95Ms === undefined)
			lines.push(`missing p95 measurement: ${label}`);
		// CPU remains milliseconds; provenance is checked at runtime/saved-report ingress.
		const values = [rep.cpuMs, rep.wallMs, ...(rep.p95Ms === undefined ? [] : [rep.p95Ms])];
		if (values.some((value) => !Number.isFinite(value) || value < 0)) lines.push(`invalid measurement: ${label}`);
		else if (values.some((value) => value === 0)) lines.push(`zero measurement cannot form a paired ratio: ${label}`);
	}
	return lines;
}

export function invalidations(input: BenchInput): string[] {
	const lines = [...(input.failures ?? [])];
	if (input.runtimes.length === 0) lines.push("no runtimes selected");
	if (!Number.isInteger(input.reps) || input.reps < MIN_REPS)
		lines.push(`at least ${MIN_REPS} repetitions per side are required, got ${input.reps}`);
	for (const runtime of input.runtimes) {
		for (const side of ["base", "head"] as const) {
			if (!runtime[side].available) lines.push(`required runtime missing on ${side}: ${runtime.id}`);
		}
		const { base, head } = runtime;
		if (base.available && head.available && base.version !== head.version)
			lines.push(`runtime version differs: ${runtime.id} base ${base.version} vs head ${head.version}`);
	}
	for (const series of input.series) {
		if (!series.optional && !series.present.base && !series.present.head)
			lines.push(`required scenario missing on both sides: ${series.scenario} ${series.runtimeId}`);
		if (series.present.base !== series.present.head) {
			const missing = series.present.base ? "head" : "base";
			lines.push(`scenario missing on ${missing}: ${series.scenario} ${series.runtimeId}`);
		}
		if (!series.present.base || !series.present.head) continue;
		for (const blocks of [series.calibration, series.comparison]) {
			if (blocks.length < 3) lines.push(`incomplete blocks: ${series.scenario} ${series.runtimeId}`);
			for (const block of blocks) {
				for (const reps of [block.first, block.second]) {
					if (reps.length !== input.reps)
						lines.push(`incomplete repetitions: ${series.scenario} ${series.runtimeId}`);
					lines.push(...sampleProblems(series, reps));
				}
			}
		}
	}
	return [...new Set(lines)];
}
