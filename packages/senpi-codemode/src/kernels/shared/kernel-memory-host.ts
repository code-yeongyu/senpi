import type { KernelMemoryReport, KernelMemoryThresholds } from "../../bridge/memory-protocol.ts";
import type { KernelToHostMessage } from "../../bridge/protocol.ts";
import type { EvalLanguage } from "../../tool/types.ts";
import { KernelMemoryPolicy } from "./kernel-memory.ts";

type ResultMessage = Extract<KernelToHostMessage, { type: "result" }>;

/** Reads another process's memory footprint; `readProcessFootprint` from `@code-yeongyu/senpi` in production. */
export type FootprintReader = (pid: number) => { readonly bytes: number } | undefined;

export interface KernelMemoryHostOptions {
	/**
	 * Host-measured kernel (rb, jl): the host reads the interpreter's footprint after each result and
	 * replaces the runner's live reading with it; the runner names its largest globals on demand, so the
	 * notice and the ceiling both apply, with every reading counting (no collection precedes it).
	 */
	readonly readFootprint?: FootprintReader;
}

/**
 * The kernel-host half of the memory contract for kernels that restart by replacing their process
 * (py, rb, jl): annotates each settled result through the shared {@link KernelMemoryPolicy} and tells the
 * host when an over-ceiling kernel may restart - only once no cell is running or queued on it, so a cell
 * queued behind the offending one still sees its globals and no result is ever lost.
 */
export class KernelMemoryHost {
	readonly #policy: KernelMemoryPolicy;
	readonly #readFootprint: FootprintReader | undefined;

	constructor(language: EvalLanguage, thresholds: KernelMemoryThresholds, options: KernelMemoryHostOptions = {}) {
		this.#readFootprint = options.readFootprint;
		this.#policy =
			this.#readFootprint === undefined
				? new KernelMemoryPolicy(language, thresholds)
				: new KernelMemoryPolicy(language, thresholds, { collects: false });
	}

	annotate(result: ResultMessage, pid?: number): ResultMessage {
		return this.annotateReport(result, this.readReport(result, pid));
	}

	readReport(result: ResultMessage, pid?: number): KernelMemoryReport | undefined {
		const runnerReport = result.memory;
		return this.#readFootprint === undefined
			? runnerReport
			: this.#footprintReport(this.#readFootprint, pid, runnerReport);
	}

	needsGlobals(report: KernelMemoryReport): boolean {
		const { noticeBytes, ceilingBytes } = this.#policy.thresholds;
		// Collect at or above the host-read notice threshold or ceiling, regardless of notice hysteresis;
		// never collect below both thresholds. Zero disables a threshold, not the lazy diagnostic gate.
		return (
			(noticeBytes > 0 && report.liveBytes >= noticeBytes) || (ceilingBytes > 0 && report.liveBytes >= ceilingBytes)
		);
	}

	annotateReport(result: ResultMessage, report: KernelMemoryReport | undefined): ResultMessage {
		if (report === undefined) return result;
		const memory = this.#policy.annotate(report);
		// Safety accounting still observes every cell, but ordinary host-measured results carry no payload.
		// A recycle announcement remains visible even when the replacement process is below threshold.
		if (this.#readFootprint !== undefined && !this.needsGlobals(report) && memory.notice === undefined) {
			const { memory: _memory, ...ordinary } = result;
			return ordinary;
		}
		return { ...result, memory };
	}

	/**
	 * True when the kernel must restart now: it went over its ceiling and `idle` (nothing running or queued).
	 * The next result the kernel produces then carries `recycled: true` and the restarted notice.
	 */
	claimRecycle(idle: boolean): boolean {
		if (!idle || !this.#policy.recyclePending) return false;
		this.#policy.recycleStarted();
		return true;
	}

	processReplaced(): void {
		this.#policy.kernelRetired();
	}

	#footprintReport(read: FootprintReader, pid: number | undefined, runnerReport: ResultMessage["memory"]) {
		if (pid === undefined) return undefined;
		const footprint = read(pid);
		if (footprint === undefined) return undefined;
		return {
			liveBytes: Math.round(footprint.bytes),
			measure: "footprint" as const,
			...(runnerReport?.globals === undefined ? {} : { globals: runnerReport.globals }),
		};
	}
}
