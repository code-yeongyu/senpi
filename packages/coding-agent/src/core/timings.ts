import { envValue } from "./brand.ts";

/**
 * Central timing instrumentation for startup profiling.
 * Enable with PI_TIMING=1 environment variable.
 */

const ENABLED = envValue("TIMING") === "1";
export interface TimingEntry {
	label: string;
	ms: number;
}

interface TimingNamespace {
	timings: TimingEntry[];
	lastTime: number;
}

export type TimingLabel = "main" | "extensions" | "reload" | "tui" | "switch";

const timingNamespaces = new Map<TimingLabel, TimingNamespace>();

// `performance.now()` rather than `Date.now()`: the phases now being hunted are 20-60ms, and a
// whole-millisecond clock cannot tell a 20ms mark from a 29ms one. Rounding happens at print time.
function now(): number {
	return performance.now();
}

export function resetTimings(namespace: TimingLabel = "main"): void {
	if (!ENABLED) return;
	timingNamespaces.set(namespace, { timings: [], lastTime: now() });
}

export function time(label: string, namespace: TimingLabel = "main"): void {
	if (!ENABLED) return;
	const now = performance.now();

	if (!timingNamespaces.has(namespace)) {
		resetTimings(namespace);
	}

	const timingNamespace = timingNamespaces.get(namespace)!;
	timingNamespace.timings.push({ label, ms: now - timingNamespace.lastTime });
	timingNamespace.lastTime = now;
}

/**
 * Record a phase this module could not measure itself - a duration derived from the process clock,
 * such as everything that happened before the first instrumented statement ran. The namespace's
 * cursor is left untouched, so the next `time()` call still measures from where it was.
 */
export function recordTiming(label: string, ms: number, namespace: TimingLabel = "main"): void {
	if (!ENABLED) return;
	const timingNamespace = timingNamespaces.get(namespace) ?? { timings: [], lastTime: now() };
	timingNamespaces.set(namespace, timingNamespace);
	timingNamespace.timings.push({ label, ms });
}

function printTimingGroup(title: string, timings: TimingNamespace["timings"]): void {
	const printableTimings = timings.filter((timing) => timing.ms >= 0);
	if (printableTimings.length === 0) return;
	console.error(`\n--- ${title} ---`);
	for (const t of printableTimings) {
		console.error(`  ${t.label}: ${Math.round(t.ms)}ms`);
	}
	console.error(`  TOTAL: ${Math.round(printableTimings.reduce((a, b) => a + b.ms, 0))}ms`);
	console.error(`${"-".repeat(title.length + 8)}\n`);
}

export function getTimings(namespace: TimingLabel): readonly TimingEntry[] {
	return timingNamespaces.get(namespace)?.timings ?? [];
}

export function formatTimings(namespace: TimingLabel): string | undefined {
	const entries = getTimings(namespace).filter((entry) => entry.ms >= 0);
	if (entries.length === 0) return undefined;
	const total = entries.reduce((sum, entry) => sum + entry.ms, 0);
	const parts = entries.map((entry) => `${entry.label} ${Math.round(entry.ms)}ms`).join("  ");
	return `${parts}  |  total ${Math.round(total)}ms`;
}

export function printTimings(): void {
	if (!ENABLED) return;
	for (const [namespace, timingNamespace] of timingNamespaces) {
		printTimingGroup(`Startup Timings: ${namespace}`, timingNamespace.timings);
	}
}
