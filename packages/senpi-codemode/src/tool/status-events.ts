import type { EvalStatusEvent } from "./types.ts";

export function upsertStatusEvent(events: EvalStatusEvent[], event: EvalStatusEvent): void {
	if (event.op === "agent" && typeof event.id === "string") {
		const index = events.findIndex((candidate) => candidate.op === "agent" && candidate.id === event.id);
		if (index >= 0) {
			events[index] = event;
			return;
		}
	}
	events.push(event);
}
