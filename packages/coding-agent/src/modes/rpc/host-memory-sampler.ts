import { readCodemodeKernelRows, readMainThreadHeapBytes } from "../../core/memory-report/kernel-registry-read.ts";
import { type ProcessFootprint, type ProcessFootprintMeasure, readOwnFootprint } from "../../core/process-footprint.ts";
import type { RpcHostKernelMemory, RpcHostMemoryPressureEvent } from "./rpc-types.ts";

/** Environment override for the memory warning threshold (compared with the footprint), in megabytes. */
export const HOST_RSS_WARN_MB_ENV = "SENPI_RPC_HOST_RSS_WARN_MB";
export const DEFAULT_HOST_RSS_WARN_MB = 4096;
/** Sampling interval. Memory moves slowly; this is bookkeeping, not a hot loop. */
export const HOST_MEMORY_SAMPLE_MS = 30_000;
/** One stderr line per window, however many samples stay above the threshold. */
export const HOST_MEMORY_STDERR_INTERVAL_MS = 5 * 60_000;

const BYTES_PER_MEGABYTE = 1024 * 1024;

/** One sample: the footprint that decides pressure, the RSS `ps` would show beside it, and the heap split. */
export interface HostMemoryReading {
	readonly footprintMb: number;
	readonly measure: ProcessFootprintMeasure;
	readonly rssMb: number;
	/** Main-thread heap in bytes: `bun:jsc heapSize()` when the runtime offers it, else `heapUsed`. */
	readonly main: { readonly heapBytes: number };
	/** Every kernel the codemode extension's registry holds, mapped to its session; a vanished kernel is absent. */
	readonly kernels: readonly RpcHostKernelMemory[];
}

export interface HostMemorySamplerOptions {
	/** Delivers one `host_memory_pressure` lifecycle record to every connection. */
	readonly emit: (record: RpcHostMemoryPressureEvent) => void;
	/** Live session count published with the record. */
	readonly sessions: () => number;
	/** Raised while the host is above the threshold; the router halves idle parking. */
	readonly onPressure: (pressure: boolean) => void;
	/**
	 * Raised once per pressure episode for a host that is above the threshold holding NO session.
	 * Memory a daemon cannot attribute to a session is memory nothing will return: a superseded
	 * generation in that state is pure cost and leaves (#1893).
	 */
	readonly onIdlePressure?: (reading: HostMemoryReading) => void;
	/** Defaults to one stderr line; tests capture it. */
	readonly log?: (message: string) => void;
	readonly now?: () => number;
	/** The memory the host really holds (senpi#2261: RSS stays high after memory is returned). */
	readonly readFootprint?: () => ProcessFootprint;
	/** Reported beside the footprint; never decides pressure. */
	readonly readRssBytes?: () => number;
	/**
	 * Live kernels, read from the codemode extension's process-global registry without importing it.
	 * The host injects the accessor at start; a host without the extension lists none. Main-thread
	 * only on Bun: `process.memoryUsage().heapUsed` never includes a kernel worker's heap.
	 */
	readonly readKernels?: () => readonly RpcHostKernelMemory[];
	/** Main-thread heap in bytes; defaults to `bun:jsc heapSize()` when available, else `heapUsed`. */
	readonly readMainHeap?: () => number;
	readonly env?: Readonly<Record<string, string | undefined>>;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
	if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
	const parsed = Number(value.trim());
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Memory-footprint reporter for the shared host.
 *
 * The daemon's capacity is memory, never an occupancy cap: it never counts sessions and
 * never kills one. What it does is SAY how much memory it holds - as a lifecycle record to
 * every connection and one stderr line per five minutes - and, while it is above the
 * warning threshold, tell the router to park idle sessions at half the usual window so
 * their memory returns to the process sooner. It never refuses a session: a host with
 * no resource caps admits every open whatever it holds (#2207).
 */
export class HostMemorySampler {
	private readonly emit: (record: RpcHostMemoryPressureEvent) => void;
	private readonly sessions: () => number;
	private readonly onPressure: (pressure: boolean) => void;
	private readonly onIdlePressure?: (reading: HostMemoryReading) => void;
	private readonly log: (message: string) => void;
	private readonly now: () => number;
	private readonly readFootprint: () => ProcessFootprint;
	private readonly readRssBytes: () => number;
	private readonly readKernels: () => readonly RpcHostKernelMemory[];
	private readonly readMainHeap: () => number;
	private readonly warnMb: number;
	private timer: ReturnType<typeof setInterval> | undefined;
	private pressure = false;
	private idleReported = false;
	private lastLoggedAt: number | undefined;

	constructor(options: HostMemorySamplerOptions) {
		const env = options.env ?? process.env;
		this.emit = options.emit;
		this.sessions = options.sessions;
		this.onPressure = options.onPressure;
		if (options.onIdlePressure) this.onIdlePressure = options.onIdlePressure;
		this.log = options.log ?? ((message) => void process.stderr.write(message));
		this.now = options.now ?? Date.now;
		this.readFootprint = options.readFootprint ?? readOwnFootprint;
		this.readRssBytes = options.readRssBytes ?? (() => process.memoryUsage.rss());
		this.readKernels = options.readKernels ?? readCodemodeKernelRows;
		this.readMainHeap = options.readMainHeap ?? readMainThreadHeapBytes;
		this.warnMb = parsePositiveInteger(env[HOST_RSS_WARN_MB_ENV]) ?? DEFAULT_HOST_RSS_WARN_MB;
	}

	start(): void {
		if (this.timer !== undefined) return;
		// Unref'd: memory bookkeeping must never be the reason the host stays alive.
		this.timer = setInterval(() => this.sample(), HOST_MEMORY_SAMPLE_MS);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer === undefined) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	/** One sample. Public so tests drive it on an injected clock and memory readings. */
	sample(): void {
		const footprint = this.readFootprint();
		const reading: HostMemoryReading = {
			footprintMb: Math.round(footprint.bytes / BYTES_PER_MEGABYTE),
			measure: footprint.measure,
			rssMb: Math.round(this.readRssBytes() / BYTES_PER_MEGABYTE),
			main: { heapBytes: this.readMainHeap() },
			kernels: this.readKernels(),
		};
		if (reading.footprintMb <= this.warnMb) {
			this.idleReported = false;
			if (!this.pressure) return;
			this.pressure = false;
			this.onPressure(false);
			return;
		}
		if (!this.pressure) {
			this.pressure = true;
			this.onPressure(true);
		}
		const sessions = this.sessions();
		// A session arriving ends the episode: the next empty sample above the threshold is a new
		// observation, not a repetition of this one.
		if (sessions > 0) this.idleReported = false;
		else if (!this.idleReported) {
			this.idleReported = true;
			this.onIdlePressure?.(reading);
		}
		const { footprintMb, measure, rssMb } = reading;
		this.emit({
			type: "host_memory_pressure",
			rssMb,
			footprintMb,
			measure,
			sessions,
			main: reading.main,
			kernels: reading.kernels,
		});
		const now = this.now();
		if (this.lastLoggedAt !== undefined && now - this.lastLoggedAt < HOST_MEMORY_STDERR_INTERVAL_MS) return;
		this.lastLoggedAt = now;
		this.log(
			`senpi rpc host memory pressure: footprintMb=${footprintMb} (${measure}) rssMb=${rssMb} sessions=${sessions} (idle parking halved)\n`,
		);
	}
}
