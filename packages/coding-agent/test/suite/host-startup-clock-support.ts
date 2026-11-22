import type { StartupClock } from "../../src/modes/rpc/host-startup-policy.ts";

/** A virtual monotonic clock: callbacks fire only when a test advances time past them. */
export function virtualClock(): StartupClock & { advanceTo(at: number): void } {
	let now = 1_000_000;
	const origin = now;
	const scheduled = new Map<number, { at: number; fire: () => void }>();
	let next = 0;
	return {
		now: () => now,
		scheduleAt(at, fire) {
			const id = next++;
			scheduled.set(id, { at, fire });
			return id;
		},
		cancel(handle) {
			scheduled.delete(handle as number);
		},
		advanceTo(elapsed) {
			const target = origin + elapsed;
			for (;;) {
				const due = [...scheduled.entries()]
					.filter(([, entry]) => entry.at <= target)
					.sort(([, a], [, b]) => a.at - b.at)[0];
				if (!due) break;
				now = Math.max(now, due[1].at);
				scheduled.delete(due[0]);
				due[1].fire();
			}
			now = target;
		},
	};
}
