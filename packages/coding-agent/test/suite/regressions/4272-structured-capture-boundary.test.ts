import type { InternalAgentChannel } from "@earendil-works/pi-agent-core";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { StructuredSessionLane } from "../../../src/core/structured-session-lane.ts";

const capture = vi.hoisted(() => ({ fail: false }));
vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
	return {
		...actual,
		carryAssistantCapture: (...args: Parameters<typeof actual.carryAssistantCapture>) => {
			if (capture.fail) throw new Error("capture copy failed");
			return actual.carryAssistantCapture(...args);
		},
	};
});

afterEach(() => {
	capture.fail = false;
});

// senpi#4439 delta LOW-1 (carry item 24.1): the capture copy runs inside the structured failure boundary, so its throw
// costs only that structured record and reaches `failed`; the caller's legacy delivery continues.
it("a throwing capture copy is reported to the structured listener's failure and never escapes emitEvent", () => {
	const channel = { subscribe: () => () => {} } as unknown as InternalAgentChannel;
	const lane = new StructuredSessionLane(channel, (deliver) => deliver());
	const records: unknown[] = [];
	const failures: unknown[] = [];
	lane.subscribe(
		(record) => records.push(record),
		(cause) => failures.push(cause),
	);
	const event: AgentSessionEvent = { type: "agent_start" };
	capture.fail = true;
	expect(() => lane.emitEvent(event, event)).not.toThrow();
	expect(records).toEqual([]);
	expect(failures).toHaveLength(1);
	capture.fail = false;
	lane.emitEvent(event, event);
	expect(records).toEqual([event]);
});
