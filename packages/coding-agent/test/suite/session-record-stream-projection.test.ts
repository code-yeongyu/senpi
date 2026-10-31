import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../../src/core/agent-session.ts";
import type { TurnDeadline } from "../../src/core/turn-deadline.ts";
import { ClientAdmissions } from "../../src/modes/rpc/client-admissions.ts";
import { subscribeSessionRecords } from "../../src/modes/rpc/session-record-stream.ts";
import { createHarness, type Harness } from "./harness.ts";

// senpi#3229: host connections and terminal endpoints stream a session through one projection,
// subscribeSessionRecords. These pin the two branches main added to it that no wire test reads:
// an agent_end carries the deadline that stopped the turn, and a session_abort names who aborted.

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

type Listener = (event: AgentSessionEvent) => void;

async function projected(): Promise<{ session: AgentSession; emit: Listener; records: Record<string, unknown>[] }> {
	const harness = await createHarness({ persistSession: true, extensionFactories: [] });
	harnesses.push(harness);
	const session = harness.session;
	await ClientAdmissions.forSession(session).ready;
	let listener: Listener | undefined;
	const subscribe = session.subscribe.bind(session);
	session.subscribe = (next: Listener) => {
		listener = next;
		return subscribe(next);
	};
	const records: Record<string, unknown>[] = [];
	subscribeSessionRecords(session, (record) => records.push(record as Record<string, unknown>));
	if (listener === undefined) throw new Error("subscribeSessionRecords did not subscribe");
	return { session, emit: listener, records };
}

describe("session record projection (senpi#3229)", () => {
	it("carries the deadline that stopped the turn on agent_end", async () => {
		// given
		const { session, emit, records } = await projected();
		const deadline: TurnDeadline = { kind: "inactivity", limitMs: 120_000, elapsedMs: 120_000 };
		Object.defineProperty(session, "currentDeadline", { get: () => deadline, configurable: true });
		Object.defineProperty(session, "currentAbortSource", { get: () => "system", configurable: true });

		// when
		emit({ type: "agent_end", messages: [], willRetry: false } as unknown as AgentSessionEvent);

		// then
		const end = records.find((record) => record.type === "agent_end");
		expect(end).toMatchObject({ aborted: true, abortSource: "system", deadline });
	});

	it("names the client that aborted on session_abort", async () => {
		// given
		const { session, emit, records } = await projected();
		ClientAdmissions.forSession(session).noteAbort({ connectionId: "socket-1" }, "abort-1");

		// when
		emit({ type: "session_abort" } as AgentSessionEvent);

		// then
		const aborted = records.find((record) => record.type === "session_abort");
		expect(aborted).toEqual({ type: "session_abort", abortedBy: { connectionId: "socket-1", effectId: "abort-1" } });
	});
});
