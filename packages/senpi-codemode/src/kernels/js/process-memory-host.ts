import type { KernelMemoryThresholds } from "../../bridge/memory-protocol.ts";
import { restartNotice } from "../shared/kernel-death.ts";
import { KernelMemoryPolicy } from "../shared/kernel-memory.ts";
import type { ResultMessage } from "./kernel-contract.ts";

export interface JavaScriptProcessMemoryReading {
	readonly liveBytes: number;
	readonly measure: "footprint";
}

export type JavaScriptProcessFootprintReader = (pid: number) => { readonly bytes: number } | undefined;

// Host-side memory for a process-mode js kernel: the in-heap worker reading cannot cross a process
// boundary, so the host reads the child's footprint (the py/rb/jl pattern) and the shared policy
// applies the notice and the ceiling. A crashed child re-announces itself through the restart notice
// on the next result, mirroring ReplaceableKernel's restarted tag.
export class JavaScriptProcessMemoryHost {
	readonly #policy: KernelMemoryPolicy;
	readonly #readFootprint: JavaScriptProcessFootprintReader | undefined;
	#lastLiveBytes: number | undefined;
	#restarted: string | null = null;

	constructor(thresholds: KernelMemoryThresholds, readFootprint?: JavaScriptProcessFootprintReader) {
		this.#readFootprint = readFootprint;
		this.#policy = new KernelMemoryPolicy("js", thresholds, { collects: readFootprint === undefined });
	}

	get thresholds(): KernelMemoryThresholds {
		return this.#policy.thresholds;
	}

	lastLiveBytes(pid: () => number | undefined): number | undefined {
		const reading = this.#read(pid);
		if (reading !== undefined) this.#lastLiveBytes = reading.liveBytes;
		return this.#lastLiveBytes;
	}

	query(pid: () => number | undefined): JavaScriptProcessMemoryReading | undefined {
		const reading = this.#read(pid);
		if (reading !== undefined) this.#lastLiveBytes = reading.liveBytes;
		return reading;
	}

	settled(message: ResultMessage, pid: () => number | undefined): ResultMessage {
		const reading = this.#read(pid);
		if (reading !== undefined) this.#lastLiveBytes = reading.liveBytes;
		let result: ResultMessage = message;
		if (reading !== undefined) {
			const report = { liveBytes: reading.liveBytes, measure: "footprint" as const };
			result = { ...result, memory: this.#policy.annotate(report) };
		}
		if (this.#restarted !== null) {
			const notice = this.#restarted;
			this.#restarted = null;
			result = { ...result, notice, kernelState: "restarted" };
		}
		return result;
	}

	claimRecycle(idle: boolean): boolean {
		if (!idle || !this.#policy.recyclePending) return false;
		this.#policy.recycleStarted();
		return true;
	}

	markRestarted(error: Error): void {
		this.#restarted = restartNotice("js", error.message);
	}

	workerLost(): void {
		this.#policy.kernelRetired();
		this.#lastLiveBytes = undefined;
	}

	#read(pid: () => number | undefined): JavaScriptProcessMemoryReading | undefined {
		if (this.#readFootprint === undefined) return undefined;
		const current = pid();
		if (current === undefined) return undefined;
		const footprint = this.#readFootprint(current);
		if (footprint === undefined) return undefined;
		return { liveBytes: Math.round(footprint.bytes), measure: "footprint" };
	}
}
