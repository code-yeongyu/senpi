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

export type TimingLabel = "main" | "extensions" | "reload";

const timingNamespaces = new Map<TimingLabel, TimingNamespace>();

export function resetTimings(namespace: TimingLabel = "main"): void {
	if (!ENABLED) return;
	timingNamespaces.set(namespace, { timings: [], lastTime: Date.now() });
}

export function time(label: string, namespace: TimingLabel = "main"): void {
	if (!ENABLED) return;
	const now = Date.now();

	if (!timingNamespaces.has(namespace)) {
		resetTimings(namespace);
	}

	const timingNamespace = timingNamespaces.get(namespace)!;
	timingNamespace.timings.push({ label, ms: now - timingNamespace.lastTime });
	timingNamespace.lastTime = now;
}

function printTimingGroup(title: string, timings: TimingNamespace["timings"]): void {
	const printableTimings = timings.filter((timing) => timing.ms >= 0);
	if (printableTimings.length === 0) return;
	console.error(`\n--- ${title} ---`);
	for (const t of printableTimings) {
		console.error(`  ${t.label}: ${t.ms}ms`);
	}
	console.error(`  TOTAL: ${printableTimings.reduce((a, b) => a + b.ms, 0)}ms`);
	console.error(`${"-".repeat(title.length + 8)}\n`);
}

export function getTimings(namespace: TimingLabel): readonly TimingEntry[] {
	return timingNamespaces.get(namespace)?.timings ?? [];
}

export function formatTimings(namespace: TimingLabel): string | undefined {
	const entries = getTimings(namespace).filter((entry) => entry.ms >= 0);
	if (entries.length === 0) return undefined;
	const total = entries.reduce((sum, entry) => sum + entry.ms, 0);
	const parts = entries.map((entry) => `${entry.label} ${entry.ms}ms`).join("  ");
	return `${parts}  |  total ${total}ms`;
}

export function printTimings(): void {
	if (!ENABLED) return;
	for (const [namespace, timingNamespace] of timingNamespaces) {
		printTimingGroup(`Startup Timings: ${namespace}`, timingNamespace.timings);
	}
}
