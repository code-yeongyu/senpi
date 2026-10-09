import { readCodemodeKernelRows, readMainThreadHeapBytes } from "../../core/memory-report/kernel-registry-read.ts";
import { type HostMemoryReading, HostMemorySampler } from "./host-memory-sampler.ts";
import { ZeroSessionTrimmer } from "./host-zero-session-trim.ts";
import { LoopLagWatchdog } from "./loop-lag-watchdog.ts";
import type { SessionCommandRouter } from "./session-command-router.ts";
import type { SessionEventWriter } from "./session-event-writer.ts";

/**
 * Arm the host's self-observation: event-loop stall detection with per-session
 * attribution, and RSS reporting that tightens idle parking under pressure. Both run on
 * unref'd timers, and neither refuses, aborts or kills anything (#2207); a host that drops to zero
 * sessions collects once and reports it (`host_trimmed`).
 */
export function startHostObservers(
	router: SessionCommandRouter,
	writer: SessionEventWriter,
	options: { readonly trim: ZeroSessionTrimmer; readonly onIdlePressure?: (reading: HostMemoryReading) => void },
): { stop: () => void } {
	const loopLag = new LoopLagWatchdog({ emit: (record) => writer.broadcastHostRecord(record) });
	const kernels = readCodemodeKernelRows;
	const memory = new HostMemorySampler({
		emit: (record) => writer.broadcastHostRecord(record),
		sessions: () => router.sessionCount,
		onPressure: (pressure) => router.setMemoryPressure(pressure),
		readKernels: kernels,
		...(options.onIdlePressure ? { onIdlePressure: options.onIdlePressure } : {}),
	});
	router.setHostMemoryView({
		mainHeapBytes: readMainThreadHeapBytes,
		kernels,
	});
	const { trim } = options;
	loopLag.start();
	memory.start();
	trim.start();
	return {
		stop: () => {
			loopLag.stop();
			memory.stop();
			trim.stop();
		},
	};
}

/** Built before the host core so the registry can signal every open and close to it. */
export function createZeroSessionTrim(writer: SessionEventWriter, sessions: () => number): ZeroSessionTrimmer {
	return new ZeroSessionTrimmer({ emit: (record) => writer.broadcastHostRecord(record), sessions });
}
