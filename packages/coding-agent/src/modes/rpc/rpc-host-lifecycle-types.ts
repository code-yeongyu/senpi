/** The HOST-level lifecycle records: sent to every connection, about the process rather than a session. */
import type { ProcessFootprintMeasure } from "../../core/process-footprint.ts";

/** Sent once to every connection before this generation starts parking for a handoff. */
export interface RpcHostSupersededEvent {
	type: "host_superseded";
	instanceId: string;
	generation: number;
	/** Public endpoint of the successor, or null for a drain without a known successor. */
	successor: { socket: string } | null;
}

/**
 * Emitted when the host's event loop was blocked long enough to stall every session it
 * serves, naming the routing handle and tool whose work held it when that can be
 * attributed. Informational: the host never aborts or refuses anything because of it.
 */
export interface RpcHostStalledEvent {
	type: "host_stalled";
	/** How late the host's own 200ms timer was invoked, i.e. how long the loop was held. */
	driftMs: number;
	/** Routing handle blamed for the stall, absent when no session work was running. */
	sessionId?: string;
	/** Tool that session was executing, when the stall happened inside one. */
	tool?: string;
	/**
	 * Process CPU time spent during the stalled window, in milliseconds. Near `driftMs`: the host
	 * was busy (JS work or a collection). Near zero: the process did not run (starved or waiting).
	 */
	processCpuMs?: number;
	/** JS heap change across the stalled window, in megabytes; a large drop means a collection ran. */
	heapDeltaMb?: number;
}

/**
 * Emitted while the host process's memory footprint is above its warning threshold. Capacity is memory,
 * never a refusal: the host reports the pressure and parks idle sessions sooner, and
 * never declines or kills a session because of it.
 */
export interface RpcHostMemoryPressureEvent {
	type: "host_memory_pressure";
	/** Resident set size of the host process, in megabytes (what `ps` shows; it stays high after memory is returned). */
	rssMb: number;
	/**
	 * Memory footprint of the host process, in megabytes: the number compared with the threshold (senpi#2261).
	 * Hosts released before it omit this and `measure`.
	 */
	footprintMb?: number;
	/** Kernel counter behind `footprintMb`; `"rss"` when the platform exposes no footprint counter. */
	measure?: ProcessFootprintMeasure;
	/** Live sessions the host is holding, including ones opening or closing. */
	sessions: number;
	/**
	 * Main-thread heap in bytes (senpi#1960): `bun:jsc heapSize()` when the runtime offers it, else
	 * `process.memoryUsage().heapUsed` - which on Bun counts the main thread only, never a kernel
	 * worker's heap (the loop-lag watchdog's `heapDeltaMb` reads the same main-thread number).
	 */
	main?: { readonly heapBytes: number };
	/**
	 * Every live kernel, mapped to its session: a JS kernel's own heap estimate, an interpreter's
	 * process footprint otherwise. A kernel without a reading yet reports `liveBytes: 0`; one that
	 * crashed between samples is absent, never repeated with a stale number.
	 */
	kernels?: readonly RpcHostKernelMemory[];
}

/** One kernel's memory as the host reports it on the pressure event and the session listing. */
export interface RpcHostKernelMemory {
	readonly sessionId: string;
	readonly language: string;
	readonly liveBytes: number;
	/** `"heap"` for a JS worker's own estimate; `"footprint"` for an interpreter process. */
	readonly measure: string;
}

/**
 * Emitted once when a host that held sessions drops to zero of them and collects: the footprint before
 * and after, so a client can see what the idle host returned. `collected` is false where the runtime
 * exposes no full collection (Node without `--expose-gc`); the record is still sent.
 */
export interface RpcHostTrimmedEvent {
	type: "host_trimmed";
	footprintBeforeMb: number;
	footprintAfterMb: number;
	measure: ProcessFootprintMeasure;
	collected: boolean;
}

export type RpcHostLifecycleEvent =
	| RpcHostSupersededEvent
	| RpcHostStalledEvent
	| RpcHostMemoryPressureEvent
	| RpcHostTrimmedEvent;
