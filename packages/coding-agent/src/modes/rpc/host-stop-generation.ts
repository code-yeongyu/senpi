import type { RegisteredHost } from "./host-daemon-registration.ts";
import { parseJson } from "./host-daemon-state.ts";
import { processStartTimeIsUnreadable } from "./host-stop-start-time.ts";

/**
 * The registration the operator saw and authorized, never a newly resolved target. `processStartTime`
 * is null where the platform cannot read it (Windows); the key itself is always present.
 */
export interface HostStopGeneration {
	readonly instanceId: string;
	readonly generation: number;
	readonly pid: number;
	readonly processStartTime: string | null;
}

export function parseHostStopGeneration(text: string): HostStopGeneration | undefined {
	const value = parseJson(text);
	if (
		!value ||
		typeof value.instanceId !== "string" ||
		value.instanceId.length === 0 ||
		typeof value.generation !== "number" ||
		!Number.isSafeInteger(value.generation) ||
		value.generation < 0 ||
		typeof value.pid !== "number" ||
		!Number.isSafeInteger(value.pid) ||
		value.pid <= 0 ||
		!(
			value.processStartTime === null ||
			(typeof value.processStartTime === "string" && value.processStartTime.length > 0)
		)
	)
		return undefined;
	return {
		instanceId: value.instanceId,
		generation: value.generation,
		pid: value.pid,
		processStartTime: value.processStartTime,
	};
}

/**
 * How the current registration compares with the confirmed one:
 * - `proven`: same generation, and the start times agree; the live process is still checked before signalling.
 * - `bound_without_start_time`: same pid, instance and generation on a platform that records no start time.
 * - `stale`: a different generation, pid or start time holds the endpoint now.
 * - `unprovable`: same generation, but the start time cannot prove the process (`unknown_owner`).
 */
export type StopGenerationMatch = "proven" | "bound_without_start_time" | "stale" | "unprovable";

export function compareStopGeneration(
	registered: RegisteredHost | undefined,
	expected: HostStopGeneration,
): StopGenerationMatch {
	if (
		registered?.instanceId !== expected.instanceId ||
		registered.generation !== expected.generation ||
		registered.record.pid !== expected.pid
	)
		return "stale";
	const recorded = registered.record.processStartTime;
	if (recorded !== null && expected.processStartTime !== null)
		return recorded === expected.processStartTime ? "proven" : "stale";
	if (recorded === null && expected.processStartTime === null && processStartTimeIsUnreadable())
		return "bound_without_start_time";
	return "unprovable";
}
