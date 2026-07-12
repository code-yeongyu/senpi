import { describe, expect, it } from "vitest";
import { upsertStatusEvent } from "../src/tool/status-events.ts";
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
});
