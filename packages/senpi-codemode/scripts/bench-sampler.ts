import { loadavg } from "node:os";
import { runProcess } from "./bench-target.ts";

export const HOST_SAMPLE_INTERVAL_MS = 30_000;
const TOP_PROCESSES = 3;

export interface TopProcess {
	readonly pid: number;
	readonly cpuPercent: number;
	readonly command: string;
}

export interface HostSample {
	readonly at: string;
	readonly loadavg: readonly number[];
	readonly topProcesses: readonly TopProcess[];
}

export type SampleHost = () => Promise<HostSample>;

function parseProcesses(stdout: string): TopProcess[] {
	const processes: TopProcess[] = [];
	for (const line of stdout.split("\n").slice(1)) {
		const match = /^\s*(\d+(?:\.\d+)?)\s+(\d+)\s+(.+)$/u.exec(line);
		if (!match?.[1] || !match[2] || !match[3]) continue;
		processes.push({ cpuPercent: Number(match[1]), pid: Number(match[2]), command: match[3].trim() });
	}
	return processes.sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, TOP_PROCESSES);
}

/** Host load plus the busiest processes, so foreign work during a block is visible in the report itself. */
export const sampleHost: SampleHost = async () => {
	const at = new Date().toISOString();
	const load = loadavg();
	if (process.platform === "win32") return { at, loadavg: load, topProcesses: [] };
	const listing = await runProcess(["ps", "-Ao", "pcpu=CPU,pid=PID,comm=COMMAND"], { cwd: process.cwd() }).catch(
		() => undefined,
	);
	return { at, loadavg: load, topProcesses: parseProcesses(listing?.stdout ?? "") };
};

/** Samples now and every interval until stopped; samples never overlap, and stop returns them in order. */
export function startHostSampler(sample: SampleHost, intervalMs = HOST_SAMPLE_INTERVAL_MS) {
	const samples: HostSample[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	let inFlight: Promise<void> = Promise.resolve();
	const tick = () => {
		inFlight = sample().then((value) => {
			samples.push(value);
			if (stopped) return;
			timer = setTimeout(tick, intervalMs);
			timer.unref?.();
		});
	};
	tick();
	return {
		async stop(): Promise<readonly HostSample[]> {
			stopped = true;
			clearTimeout(timer);
			await inFlight;
			samples.push(await sample());
			return samples;
		},
	};
}

export function summarizeSamples(samples: readonly HostSample[]): string {
	const peak = Math.max(...samples.map((entry) => entry.loadavg[0] ?? 0));
	const busiest = samples.flatMap((entry) => entry.topProcesses).sort((a, b) => b.cpuPercent - a.cpuPercent)[0];
	const top = busiest ? `${busiest.command} ${busiest.cpuPercent}%` : "n/a";
	return `${samples.length} samples, peak 1-min load ${peak.toFixed(2)}, busiest ${top}`;
}
