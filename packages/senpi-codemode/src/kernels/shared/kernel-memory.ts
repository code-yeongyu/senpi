import type { KernelMemoryGlobal, KernelMemoryReport, KernelMemoryThresholds } from "../../bridge/memory-protocol.ts";
import type { EvalLanguage } from "../../tool/types.ts";

const NOTICE_GROWTH_RATIO = 1.25;
const NOTICED_GLOBALS = 5;
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

interface CeilingBreach {
	readonly liveBytes: number;
	readonly globals: readonly KernelMemoryGlobal[];
}

export interface KernelMemoryPolicyOptions {
	/**
	 * The kernel collects before it reports (js, py): only readings taken right after a collection
	 * (`gcRan`) count toward the notice and the ceiling. A kernel whose footprint the host reads without
	 * any collection (rb, jl) sets this to `false`, and every reading counts toward the ceiling.
	 */
	readonly collects?: boolean;
}

/** How a cell drops a global in each language, named in the large-globals notice. */
const DROP_ADVICE: Readonly<Record<EvalLanguage, (name: string) => string>> = {
	js: (name) => `${name} = undefined`,
	py: (name) => `del ${name}`,
	rb: (name) => `${name} = nil`,
	jl: (name) => `${name} = nothing`,
};

/**
 * Per-kernel memory policy: decides which results carry the large-globals notice (hysteresis per
 * language), when live memory crossed the ceiling, and which result announces the restart. Pure state;
 * the kernel host performs the restart once its run queue is empty.
 */
export class KernelMemoryPolicy {
	readonly #language: EvalLanguage;
	readonly #thresholds: KernelMemoryThresholds;
	readonly #collects: boolean;
	#lastNotifiedLive = 0;
	#lastObservedLive = 0;
	#pendingRecycle: CeilingBreach | null = null;
	#announceRecycle: CeilingBreach | null = null;

	constructor(language: EvalLanguage, thresholds: KernelMemoryThresholds, options: KernelMemoryPolicyOptions = {}) {
		this.#language = language;
		this.#thresholds = thresholds;
		this.#collects = options.collects ?? true;
	}

	get thresholds(): KernelMemoryThresholds {
		return this.#thresholds;
	}

	get recyclePending(): boolean {
		return this.#pendingRecycle !== null;
	}

	/** Any measurement below half the notice threshold re-arms the notice for a later large global. */
	observeLive(liveBytes: number): void {
		if (liveBytes < this.#thresholds.noticeBytes / 2) this.#lastNotifiedLive = 0;
		this.#lastObservedLive = liveBytes;
	}

	annotate(report: KernelMemoryReport): KernelMemoryReport {
		const crossedUpward = this.#lastObservedLive < this.#thresholds.noticeBytes;
		this.observeLive(report.liveBytes);
		const announced = this.#announceRecycle;
		if (announced !== null) {
			this.#announceRecycle = null;
			return { ...report, recycled: true, notice: this.#recycledNotice(announced) };
		}
		if (this.#collects && report.gcRan !== true) return report;
		const { ceilingBytes, noticeBytes } = this.#thresholds;
		if (ceilingBytes > 0 && report.liveBytes >= ceilingBytes) return this.#overCeiling(report);
		if (noticeBytes === 0 || report.liveBytes < noticeBytes) return report;
		const grew = report.liveBytes >= this.#lastNotifiedLive * NOTICE_GROWTH_RATIO;
		if (!crossedUpward && !grew) return report;
		this.#lastNotifiedLive = report.liveBytes;
		return { ...report, notice: this.#sizeNotice(report) };
	}

	/** The host is restarting the kernel; the next result it produces announces the restart. */
	recycleStarted(): void {
		this.#announceRecycle = this.#pendingRecycle;
		this.#pendingRecycle = null;
		this.#lastNotifiedLive = 0;
		this.#lastObservedLive = 0;
	}

	/** The worker or process is gone for another reason (reset, crash, stop): its memory went with it. */
	kernelRetired(): void {
		this.#pendingRecycle = null;
		this.#lastNotifiedLive = 0;
		this.#lastObservedLive = 0;
	}

	#overCeiling(report: KernelMemoryReport): KernelMemoryReport {
		this.#lastNotifiedLive = report.liveBytes;
		if (this.#pendingRecycle !== null) return { ...report, overCeiling: true };
		const breach = { liveBytes: report.liveBytes, globals: report.globals ?? [] };
		this.#pendingRecycle = breach;
		return { ...report, overCeiling: true, notice: this.#ceilingNotice(breach) };
	}

	#sizeNotice(report: KernelMemoryReport): string {
		const globals = report.globals ?? [];
		const drop = DROP_ADVICE[this.#language](globals[0]?.name ?? "name");
		return `[${this.#language} kernel holds ${formatBytes(report.liveBytes)} ${this.#liveMeasure} (notice at ${formatBytes(this.#thresholds.noticeBytes)}).${globalsPhrase("Largest globals", globals)} Drop what you no longer need (${drop}) or run with reset: true.]`;
	}

	#ceilingNotice(breach: CeilingBreach): string {
		return `[${this.#language} kernel holds ${formatBytes(breach.liveBytes)} ${this.#liveMeasure}, over the ${formatBytes(this.#thresholds.ceilingBytes)} ceiling. It restarts before the next cell you submit and every global is lost.${globalsPhrase("Largest globals", breach.globals)}]`;
	}

	#recycledNotice(breach: CeilingBreach): string {
		return `[${this.#language} kernel was restarted before this cell: ${formatBytes(breach.liveBytes)} ${this.#liveMeasure} exceeded the ${formatBytes(this.#thresholds.ceilingBytes)} ceiling. Every global from earlier cells is gone.${globalsPhrase("Largest globals were", breach.globals)}]`;
	}

	get #liveMeasure(): string {
		return this.#collects ? "live after GC" : "in its process footprint";
	}
}

export function formatBytes(bytes: number): string {
	if (bytes >= GIB) return `${Number((bytes / GIB).toFixed(1))} GB`;
	return `${Math.max(1, Math.round(bytes / MIB))} MB`;
}

function globalsPhrase(label: string, globals: readonly KernelMemoryGlobal[]): string {
	if (globals.length === 0) return "";
	const listed = globals
		.slice(0, NOTICED_GLOBALS)
		.map((global) => `${global.name} ${global.approximate === true ? "~" : ""}${formatBytes(global.bytes)}`);
	return ` ${label}: ${listed.join(", ")}.`;
}
