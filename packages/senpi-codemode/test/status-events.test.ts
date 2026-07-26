import { describe, expect, it } from "vitest";
import { STATUS_EVENT_HISTORY_LIMIT, upsertStatusEvent } from "../src/tool/status-events.ts";
import type { EvalStatusEvent } from "../src/tool/types.ts";

describe("upsertStatusEvent", () => {
	it("appends distinct agent events in first-seen order", () => {
		const events: EvalStatusEvent[] = [];

		upsertStatusEvent(events, { op: "agent", id: "a1", status: "running" });
		upsertStatusEvent(events, { op: "agent", id: "a2", status: "running" });

		expect(events).toEqual([
			{ op: "agent", id: "a1", status: "running" },
			{ op: "agent", id: "a2", status: "running" },
		]);
	});

	it("coalesces agent progress by id without changing its original position", () => {
		const events: EvalStatusEvent[] = [];

		upsertStatusEvent(events, { op: "agent", id: "a1", status: "running" });
		upsertStatusEvent(events, { op: "read", path: "/tmp/x" });
		upsertStatusEvent(events, { op: "agent", id: "a1", status: "completed" });

		expect(events).toEqual([
			{ op: "agent", id: "a1", status: "completed" },
			{ op: "read", path: "/tmp/x" },
		]);
	});

	it("always appends non-agent operations, including duplicates", () => {
		const events: EvalStatusEvent[] = [];

		upsertStatusEvent(events, { op: "read", path: "/tmp/x" });
		upsertStatusEvent(events, { op: "read", path: "/tmp/x" });
		upsertStatusEvent(events, { op: "agent", status: "missing-id" });
		upsertStatusEvent(events, { op: "agent", status: "missing-id" });

		expect(events).toHaveLength(4);
		expect(events).toEqual([
			{ op: "read", path: "/tmp/x" },
			{ op: "read", path: "/tmp/x" },
			{ op: "agent", status: "missing-id" },
			{ op: "agent", status: "missing-id" },
		]);
	});

	it("bounds status history while reporting how many earlier events were omitted", () => {
		const events: EvalStatusEvent[] = [];
		const totalEvents = STATUS_EVENT_HISTORY_LIMIT + 25;

		for (let index = 0; index < totalEvents; index += 1) {
			upsertStatusEvent(events, {
				op: "read",
				path: `/tmp/file-${index}.txt`,
				preview: "x".repeat(500),
			});
		}

		expect(events).toHaveLength(STATUS_EVENT_HISTORY_LIMIT);
		expect(events[0]).toEqual({ op: "status-events-omitted", count: 26 });
		expect(events[1]).toMatchObject({ op: "read", path: "/tmp/file-26.txt" });
		expect(events.at(-1)).toMatchObject({ op: "read", path: `/tmp/file-${totalEvents - 1}.txt` });
	});

	it("reserves the omission marker when event 101 arrives", () => {
		const events: EvalStatusEvent[] = [];

		for (let index = 0; index <= STATUS_EVENT_HISTORY_LIMIT; index += 1) {
			upsertStatusEvent(events, { op: "read", path: `/tmp/file-${index}.txt` });
		}

		expect(events).toHaveLength(STATUS_EVENT_HISTORY_LIMIT);
		expect(events[0]).toEqual({ op: "status-events-omitted", count: 2 });
		expect(events[1]).toMatchObject({ op: "read", path: "/tmp/file-2.txt" });
		expect(events.at(-1)).toMatchObject({ op: "read", path: "/tmp/file-100.txt" });
	});
});
