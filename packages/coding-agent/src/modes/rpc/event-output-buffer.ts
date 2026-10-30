import { serializeJsonLine } from "./jsonl.ts";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import { toJsonEvent } from "../json-event.ts";

type RawWriter = (chunk: string) => void;
type FlushScheduler = (flush: () => void) => void;

export type RpcEventOutputBuffer = {
	readonly enqueueEvent: (event: object) => void;
	readonly writeImmediate: (value: object) => void;
	readonly flushEvents: () => void;
};

export function createRpcEventOutputBuffer(
	writeRaw: RawWriter,
	scheduleFlush: FlushScheduler = queueMicrotask,
): RpcEventOutputBuffer {
	let pendingEventLines: string[] = [];
	const latestPartials = new Map<unknown, { index: number; deltaOnlyLine: string }>();
	let flushScheduled = false;

	const flushEvents = (): void => {
		flushScheduled = false;
		if (pendingEventLines.length === 0) return;
		writeRaw(pendingEventLines.join(""));
		pendingEventLines = [];
		latestPartials.clear();
	};

	return {
		enqueueEvent(event) {
			if ("type" in event && event.type === "message_update") {
				const key = "sessionId" in event ? event.sessionId : undefined;
				const previous = latestPartials.get(key);
				if (previous) pendingEventLines[previous.index] = previous.deltaOnlyLine;
				latestPartials.set(key, {
					index: pendingEventLines.length,
					deltaOnlyLine: serializeJsonLine(
						"message" in event ? (toJsonEvent(event as AgentSessionEvent) ?? event) : event,
					),
				});
			}
			pendingEventLines.push(serializeJsonLine(event));
			if (flushScheduled) return;
			flushScheduled = true;
			scheduleFlush(flushEvents);
		},
		writeImmediate(value) {
			flushEvents();
			writeRaw(serializeJsonLine(value));
		},
		flushEvents,
	};
}
