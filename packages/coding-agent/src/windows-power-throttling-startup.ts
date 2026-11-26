// senpi#6125: opt this process, and every child this JavaScript realm starts, out of Windows EcoQoS throttling.
// Imported by every process and worker entry, because the throttling state and the launcher patch are per process and
// per realm. A no-op off Windows, on Node, and with SENPI_KEEP_POWER_THROTTLING=1.
import { ensureWindowsPowerThrottlingOptOut, type PowerThrottlingInstall } from "./core/windows-power-throttling.ts";

/** A (header, text) pair as `appendDebugLogEntry` takes it; injectable so tests can capture the recorded entry. */
export type DebugLogEntrySink = (header: string, text: string) => void | Promise<void>;

/**
 * Records a failed self opt-out (senpi#6132) in the brand debug log: `OpenProcess` or `SetProcessInformation` can
 * fail (a higher-integrity parent, an old kernel32), and without this line a user still seeing throttled CPU has no
 * trace to attach to a support question. A successful or skipped start records and prints nothing.
 *
 * The sink loads lazily, only on this failure path: this module is the first import of every entry, and pulling
 * `config.ts` into its static graph would put it ahead of every other module in every process for one rare line.
 */
export function recordFailedStartupPowerThrottlingOptOut(
	install: PowerThrottlingInstall,
	append: DebugLogEntrySink = appendDebugLogEntryLazily,
): Promise<void> {
	if (install.status !== "installed" || install.self.ok) return Promise.resolve();
	const failure = install.self;
	return Promise.resolve(
		append(
			"windows power throttling opt-out failed",
			`step=${failure.step} win32Error=${failure.win32Error}: senpi and its children may stay throttled by EcoQoS`,
		),
	);
}

function appendDebugLogEntryLazily(header: string, text: string): Promise<void> {
	return (
		import("./core/hidden-stdout-log.ts")
			.then((log) => {
				log.appendDebugLogEntry(header, text);
			})
			// Writing the trace may never break startup, exactly like the crash log's own swallow rule.
			.catch(() => {})
	);
}

/**
 * Settles once a failed opt-out's entry is written, and at once when there is nothing to record (the sink is then
 * never loaded). A fast exit awaits it, so `--version` or an engine-free `--help` cannot exit before the write.
 */
export const startupPowerThrottlingRecorded = recordFailedStartupPowerThrottlingOptOut(
	ensureWindowsPowerThrottlingOptOut(),
);
