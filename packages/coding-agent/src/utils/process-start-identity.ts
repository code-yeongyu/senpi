/**
 * A recorded process start compared on ONE clock per platform (senpi#3816 review, mirroring
 * sisyphuslabs/omo-desktop-app#3968/#3969), so an NTP or VM wall-clock step never reads a live process as reused.
 *
 * - Linux: `/proc/<pid>/stat` start ticks on both sides. They count on the boot clock, which no wall-clock step
 *   moves, and reading them spawns nothing. A Linux `ps lstart` is derived through btime and moves with every step,
 *   so it is never compared.
 * - Elsewhere (macOS): `ps lstart` on both sides. macOS stores it as the wall time at fork and does not move it.
 */
import { readFileSync } from "node:fs";
import { processStartTimeMs, sameProcessStartMs } from "./process-identity.ts";

/** `/proc/<pid>/stat` field 22 (start time in clock ticks since boot), or `undefined` when unreadable or off Linux. */
export function readProcessStartTicks(pid: number, platform: NodeJS.Platform = process.platform): string | undefined {
	if (platform !== "linux") return undefined;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// The command name (field 2) may contain spaces and parentheses; fields resume after its last ")".
		const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
		return ticks !== undefined && /^\d+$/.test(ticks) ? ticks : undefined;
	} catch {
		return undefined;
	}
}

export interface RecordedStart {
	readonly ticks?: string;
	readonly time?: string;
}

export interface StartProbe {
	ticks(pid: number): string | undefined;
	time(pid: number): Promise<string | undefined>;
}

/** `unknown` whenever either side is missing or unreadable: an unreadable identity is never evidence of reuse. */
export type StartComparison = "same" | "changed" | "unknown";

export async function compareRecordedStart(
	pid: number,
	recorded: RecordedStart,
	platform: NodeJS.Platform,
	probe: StartProbe,
): Promise<StartComparison> {
	if (platform === "linux") {
		if (recorded.ticks === undefined) return "unknown";
		const observed = probe.ticks(pid);
		if (observed === undefined) return "unknown";
		return observed === recorded.ticks ? "same" : "changed";
	}
	if (recorded.time === undefined) return "unknown";
	const observed = await probe.time(pid);
	const recordedMs = processStartTimeMs(recorded.time);
	const observedMs = observed === undefined ? undefined : processStartTimeMs(observed);
	if (recordedMs === undefined || observedMs === undefined) return "unknown";
	return sameProcessStartMs(recordedMs, observedMs) ? "same" : "changed";
}
