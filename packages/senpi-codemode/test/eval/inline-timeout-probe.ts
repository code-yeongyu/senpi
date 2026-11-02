import type { ResultMessage } from "../../src/kernels/js/kernel-contract.ts";

export const INLINE_PROBE_BOUNDS = {
	cellTimeoutMs: 150,
	ackMs: 500,
	graceMs: 2000,
	terminateDeadlineMs: 180000,
} as const;

/** Drives the same clock used by the kernel; advancement also drains scheduled microtasks. */
export async function driveInlineTimeout(
	started: Promise<void>,
	running: Promise<ResultMessage>,
	advance: (milliseconds: number) => Promise<void>,
): Promise<ResultMessage> {
	await Promise.race([
		started,
		running.then((result) => {
			if (!result.ok) throw new Error(result.error.message);
			throw new TypeError("Inline probe settled before its startup marker");
		}),
	]);
	// Fire the kernel's cell timeout before its acknowledgement and retirement deadlines.
	await advance(INLINE_PROBE_BOUNDS.cellTimeoutMs);
	await advance(INLINE_PROBE_BOUNDS.ackMs);
	await advance(INLINE_PROBE_BOUNDS.terminateDeadlineMs);
	return await running;
}
