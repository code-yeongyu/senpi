import type { EvalStatusEvent } from "./types.ts";

export const STATUS_EVENT_HISTORY_LIMIT = 100;
const OMITTED_STATUS_EVENTS_OP = "status-events-omitted";

function trimStatusHistory(events: EvalStatusEvent[]): void {
	if (events.length <= STATUS_EVENT_HISTORY_LIMIT) return;

	const first = events[0];
	if (first?.op === OMITTED_STATUS_EVENTS_OP && typeof first.count === "number") {
		const removeCount = events.length - STATUS_EVENT_HISTORY_LIMIT;
		events.splice(1, removeCount);
		events[0] = { op: OMITTED_STATUS_EVENTS_OP, count: first.count + removeCount };
		return;
	}

	const removeCount = events.length - STATUS_EVENT_HISTORY_LIMIT + 1;
	events.splice(0, removeCount, { op: OMITTED_STATUS_EVENTS_OP, count: removeCount });
}

export function upsertStatusEvent(events: EvalStatusEvent[], event: EvalStatusEvent): void {
	if (event.op === "agent" && typeof event.id === "string") {
		const index = events.findIndex((candidate) => candidate.op === "agent" && candidate.id === event.id);
		if (index >= 0) {
			events[index] = event;
			trimStatusHistory(events);
			return;
		}
	}
	events.push(event);
	trimStatusHistory(events);
}
