import { describe, expect, it } from "vitest";
import {
	causeOfRecord,
	deriveSessionStatus,
	type SessionStatusEntryView,
	type SessionStatusRuntimeView,
	terminalOfLifecycle,
} from "../../src/modes/rpc/session-status.ts";

const entry = (overrides: Partial<SessionStatusEntryView> = {}): SessionStatusEntryView => ({
	state: "open",
	kind: "interactive",
	cwd: "/work",
	attachments: 1,
	durableSessionId: "d-1",
	sessionPath: "/work/s.jsonl",
	context: {},
	...overrides,
});

const runtime = (overrides: Partial<SessionStatusRuntimeView> = {}): SessionStatusRuntimeView => ({
	isStreaming: false,
	isCompacting: false,
	model: { provider: "faux", id: "m" },
	thinkingLevel: "off",
	steering: 0,
	followUp: 0,
	pendingQuestions: 0,
	...overrides,
});

const noQuestions = { pendingQuestions: 0 };

describe("deriveSessionStatus", () => {
	it("reports opening while the registry entry is still being built", () => {
		expect(deriveSessionStatus(entry({ state: "opening" }), undefined, noQuestions).status).toBe("opening");
	});

	it("reports opening for an open entry whose runtime view is not available yet", () => {
		expect(deriveSessionStatus(entry(), undefined, noQuestions).status).toBe("opening");
	});

	it("reports idle for an open session with no turn", () => {
		expect(deriveSessionStatus(entry(), runtime(), noQuestions)).toMatchObject({
			status: "idle",
			model: { provider: "faux", id: "m" },
			pendingQueue: { steering: 0, followUp: 0 },
		});
	});

	it("reports running while the session streams a turn", () => {
		expect(deriveSessionStatus(entry(), runtime({ isStreaming: true }), noQuestions).status).toBe("running");
	});

	it("reports compacting over running when compaction runs inside a turn", () => {
		const derived = deriveSessionStatus(entry(), runtime({ isStreaming: true, isCompacting: true }), noQuestions);
		expect(derived.status).toBe("compacting");
	});

	it("reports waiting_input from a pending question frame, even mid-turn", () => {
		expect(
			deriveSessionStatus(entry(), runtime({ isStreaming: true, isCompacting: true }), { pendingQuestions: 1 })
				.status,
		).toBe("waiting_input");
		expect(deriveSessionStatus(entry(), runtime({ pendingQuestions: 2 }), noQuestions).status).toBe("waiting_input");
	});

	it("reports unloaded with the park reason from the seal", () => {
		const parked = terminalOfLifecycle({ type: "session_parked" });
		expect(deriveSessionStatus(entry(), runtime(), noQuestions, parked)).toMatchObject({
			status: "unloaded",
			reason: "idle",
		});
		const handoff = terminalOfLifecycle({ type: "session_closed", reason: "handoff_parked" });
		expect(deriveSessionStatus(entry(), runtime(), noQuestions, handoff)).toMatchObject({
			status: "unloaded",
			reason: "handoff",
		});
		expect(terminalOfLifecycle({ type: "session_parked", reason: "unloaded" })).toEqual({
			status: "unloaded",
			reason: "unload_session",
		});
	});

	it("reports closed with today's session_closed reason, and closed for a closing entry", () => {
		const closed = terminalOfLifecycle({ type: "session_closed", reason: "client_close" });
		expect(deriveSessionStatus(entry({ attachments: -1 }), runtime(), noQuestions, closed)).toMatchObject({
			status: "closed",
			reason: "client_close",
			attachments: 0,
		});
		expect(deriveSessionStatus(entry({ state: "closing" }), runtime(), noQuestions).status).toBe("closed");
	});

	it("marks a run an abort ended as idle with reason aborted", () => {
		expect(deriveSessionStatus(entry(), runtime(), noQuestions, undefined, "abort")).toMatchObject({
			status: "idle",
			reason: "aborted",
		});
	});

	it("maps the records that change a status, and only those", () => {
		expect(causeOfRecord({ type: "agent_start" })).toBe("prompt");
		expect(causeOfRecord({ type: "session_abort" })).toBe("abort");
		expect(causeOfRecord({ type: "queue_update" })).toBe("queue");
		expect(causeOfRecord({ type: "model_changed" })).toBe("set_model");
		expect(causeOfRecord({ type: "session_replaced" })).toBe("replace");
		expect(causeOfRecord({ type: "extension_ui_request", method: "question" })).toBe("question");
		expect(causeOfRecord({ type: "extension_ui_request", method: "confirm" })).toBeUndefined();
		expect(causeOfRecord({ type: "message_update" })).toBeUndefined();
	});
});
