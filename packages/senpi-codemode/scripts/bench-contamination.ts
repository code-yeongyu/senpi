import type { BlockRecord } from "./bench-run.ts";

/**
 * The 1-minute load above which a measurement is contaminated: the host's core count. Beyond it, runnable threads
 * queue for a core, so CPU and wall time absorb scheduler wait that has nothing to do with the code under test.
 * (macOS load also counts I/O-blocked threads, so a lower, fractional ceiling would flag quiet hosts.)
 */
export function contaminationCeiling(cores: number): number {
	return cores;
}

/**
 * One failure line per block in which any measurement's start/end load or any per-block host sample exceeded the
 * ceiling. A contaminated block makes the run INCONCLUSIVE, so a load burst on one side can never feed a FAIL.
 */
export function contaminationFailures(blocks: readonly BlockRecord[], ceiling: number): string[] {
	const lines: string[] = [];
	for (const block of blocks) {
		const hot = block.measurements.filter(({ loadStart, loadEnd }) => Math.max(loadStart, loadEnd) > ceiling);
		const hotSamples = block.hostSamples.filter((sample) => (sample.loadavg[0] ?? 0) > ceiling);
		if (hot.length === 0 && hotSamples.length === 0) continue;
		const peak = Math.max(
			...hot.map(({ loadStart, loadEnd }) => Math.max(loadStart, loadEnd)),
			...hotSamples.map((sample) => sample.loadavg[0] ?? 0),
		);
		const first = hot[0];
		const where = first ? `; first ${first.runtimeId} ${first.scenario} rep ${first.rep} ${first.side}` : "";
		lines.push(
			`host contaminated in block ${block.index + 1}: ${hot.length} of ${block.measurements.length} measurements and ${hotSamples.length} of ${block.hostSamples.length} host samples above 1-minute load ${ceiling} (peak ${peak.toFixed(2)})${where}`,
		);
	}
	return lines;
}
