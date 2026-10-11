import { BenchAccountingError } from "./bench-accounting.ts";
import type { Rep } from "./bench-compare.ts";
import type { BenchSession, KernelCpu } from "./bench-session.ts";

export type Observations = Readonly<Record<string, string | number | boolean | null>>;

export interface Measured extends Rep {
	readonly hostCpuMs: number;
	readonly kernelCpuMs: number;
	readonly observations?: Observations;
}

export interface BodyResult {
	readonly p95Ms?: number;
	readonly observations?: Observations;
}

/** Full collections before a window keep earlier garbage (module graphs, prior reps) out of its CPU time. */
export function collectGarbage(): void {
	const bun: unknown = Reflect.get(globalThis, "Bun");
	const bunGc = typeof bun === "object" && bun !== null ? Reflect.get(bun, "gc") : undefined;
	if (typeof bunGc === "function") {
		Reflect.apply(bunGc, bun, [true]);
		return;
	}
	const nodeGc: unknown = Reflect.get(globalThis, "gc");
	if (typeof nodeGc === "function") Reflect.apply(nodeGc, globalThis, []);
}

/**
 * CPU is accounted per process without double counting: the host total (`process.cpuUsage()` already
 * includes JS worker threads) plus child deltas by PID. Exit receipts preserve dead children;
 * replacement CPU is added once. Live snapshots are host reads after full result reception, not clocks
 * embedded before encoding. Exit receipts cover dead interpreters. Missing usage invalidates the window.
 */
export function kernelCpuMs(before: readonly KernelCpu[], after: readonly KernelCpu[]): number {
	const prior = new Map(before.map((value) => [value.pid, value.cpuUs]));
	const final = new Map(after.map((value) => [value.pid, value.cpuUs]));
	for (const pid of prior.keys()) {
		if (!final.has(pid)) throw new BenchAccountingError(`missing exit CPU for process ${pid}`);
	}
	let cpuUs = 0;
	for (const [pid, total] of final) {
		const delta = total - (prior.get(pid) ?? 0);
		if (delta < 0) throw new BenchAccountingError(`CPU decreased for process ${pid}`);
		cpuUs += delta;
	}
	return cpuUs / 1000;
}

export interface Window {
	readonly wallMs: number;
	readonly hostCpuMs: number;
}

export async function timed<T>(body: () => Promise<T>): Promise<{ readonly value: T; readonly window: Window }> {
	collectGarbage();
	const cpu = process.cpuUsage();
	const started = performance.now();
	const value = await body();
	const wallMs = performance.now() - started;
	const used = process.cpuUsage(cpu);
	return { value, window: { wallMs, hostCpuMs: (used.user + used.system) / 1000 } };
}

export function measured(window: Window, kernelMs: number, result: BodyResult = {}): Measured {
	return {
		cpuMs: window.hostCpuMs + kernelMs,
		wallMs: window.wallMs,
		hostCpuMs: window.hostCpuMs,
		kernelCpuMs: kernelMs,
		...(result.p95Ms === undefined ? {} : { p95Ms: result.p95Ms }),
		...(result.observations === undefined ? {} : { observations: result.observations }),
	};
}

export async function measure(session: BenchSession, body: () => Promise<BodyResult>): Promise<Measured> {
	const before = await session.cpu();
	const { value, window } = await timed(body);
	const after = await session.cpu();
	return measured(window, kernelCpuMs(before, after), value);
}
