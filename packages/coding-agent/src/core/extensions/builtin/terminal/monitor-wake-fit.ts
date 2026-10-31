/**
 * Filling one monitor wake within `maxChars`, measured from the real wrapper (reminder tags, the
 * pause notice, each monitor's actual overflow notice), never an assumed reserve. Monitors with a
 * summary go first, then queue order; a monitor that does not fit whole waits for the next wake.
 * Only when the first monitor alone is too big does it send a prefix of its lines; the rest stay
 * queued. The line cap already holds per monitor at enqueue, so a wake is never clipped.
 */
import {
	monitorShareChars,
	SYSTEM_REMINDER_CLOSE,
	SYSTEM_REMINDER_OPEN,
	WAKE_BUDGET_PAUSE_NOTICE,
} from "./monitor-notify-format.ts";
import type { OverflowBook } from "./monitor-overflow.ts";
import type { MonitorEvent } from "./monitor-registry.ts";

export interface WakeShare {
	readonly events: MonitorEvent[];
	/** Every queued line went; when false the monitor keeps its rest and overflow for the next wake. */
	readonly whole: boolean;
}

export function fitWake(
	queue: readonly MonitorEvent[],
	overflow: OverflowBook,
	candidates: readonly string[],
	summaryIds: ReadonlySet<string>,
	maxChars: number,
): Map<string, WakeShare> {
	const queued = [...new Set([...queue.map((event) => event.id), ...overflow.ids()])].filter((id) =>
		candidates.includes(id),
	);
	const ordered = [...queued.filter((id) => summaryIds.has(id)), ...queued.filter((id) => !summaryIds.has(id))];
	const budget =
		maxChars - SYSTEM_REMINDER_OPEN.length - SYSTEM_REMINDER_CLOSE.length - WAKE_BUDGET_PAUSE_NOTICE.length - 1;
	const wake = new Map<string, WakeShare>();
	let chars = 0;
	for (const id of ordered) {
		overflow.flush(id);
		const own = queue.filter((event) => event.id === id);
		const share = monitorShareChars(own, overflow.notice(id));
		if (chars + share <= budget || (wake.size === 0 && own.length === 0)) {
			wake.set(id, { events: own, whole: true });
			chars += share;
		} else if (wake.size === 0) {
			let count = 1;
			while (count < own.length && monitorShareChars(own.slice(0, count + 1), "") <= budget) count += 1;
			const prefix = own.slice(0, count);
			wake.set(id, { events: prefix, whole: prefix.length === own.length && overflow.count(id) === 0 });
			chars += monitorShareChars(prefix, "");
		}
	}
	return wake;
}
