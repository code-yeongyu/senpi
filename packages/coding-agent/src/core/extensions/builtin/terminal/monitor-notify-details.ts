import type { MonitorNotificationDetail } from "../monitor-state-event.ts";
import type { OverflowBook } from "./monitor-overflow.ts";
import type { MonitorEvent } from "./monitor-registry.ts";

/** Per-monitor attribution of one wake: what it carried inline plus what overflowed. */
export function monitorDetails(
	events: readonly MonitorEvent[],
	ids: ReadonlySet<string>,
	overflowBook: OverflowBook,
): MonitorNotificationDetail[] {
	return [...ids].map((id) => {
		const own = events.filter((event) => event.id === id);
		const overflow = overflowBook.get(id);
		const kinds = new Set<MonitorEvent["type"]>(own.map((event) => event.type));
		for (const kind of overflow?.kinds ?? []) kinds.add(kind);
		const humanInput =
			own.some((event) => event.type === "line" && event.humanInput === true) || overflow?.humanInput === true;
		return {
			id,
			description: own[0]?.description ?? overflow?.description ?? id,
			eventCount: own.length + (overflow?.count ?? 0),
			kinds: [...kinds],
			...(humanInput ? { humanInput: true as const } : {}),
		};
	});
}
