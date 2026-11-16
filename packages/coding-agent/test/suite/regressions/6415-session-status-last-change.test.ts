import { describe, expect, it } from "vitest";
import { SessionStatusStream } from "../../../src/modes/rpc/session-status-stream.ts";

const OPTIONS = {
	selector: { kind: "all" },
	includeWorkers: false,
	includeContext: false,
	mirror: { kind: "none" },
	effects: false,
} as const;

function streamAt(clock: { now: Date }) {
	const stream = new SessionStatusStream({ enqueue: () => true, pendingQuestions: () => 0, now: () => clock.now });
	stream.setSource({
		sessionIds: () => ["idle-1"],
		entryView: () => ({ state: "open", kind: "interactive", cwd: "/w", attachments: 0, context: {} }),
		view: () => ({ entry: { state: "open", kind: "interactive", cwd: "/w", attachments: 0, context: {} } }),
	});
	return stream;
}

function lastChangeOfSnapshot(stream: SessionStatusStream, connectionId: string) {
	const { snapshot } = stream.subscribe(connectionId, OPTIONS);
	const record = snapshot.find((row) => row.sessionId === "idle-1");
	if (record === undefined) throw new Error("no snapshot row for idle-1");
	return record.lastChange;
}

describe("session_status lastChange for a session that never changed (senpi#6415)", () => {
	it("Given an idle session, when it is subscribed twice at different times, then both snapshots carry the same lastChange.at", () => {
		const clock = { now: new Date("2026-11-11T10:00:00.000Z") };
		const stream = streamAt(clock);
		const first = lastChangeOfSnapshot(stream, "a");
		clock.now = new Date("2026-11-11T11:30:00.000Z");
		const second = lastChangeOfSnapshot(stream, "b");
		expect(second.at).toBe(first.at);
		expect(second).toMatchObject({ cause: "open", by: "host" });
	});

	it("Given an idle session, when a real change is published, then the next snapshot carries that change's time and cause", () => {
		const clock = { now: new Date("2026-11-11T10:00:00.000Z") };
		const stream = streamAt(clock);
		lastChangeOfSnapshot(stream, "a");
		clock.now = new Date("2026-11-11T12:00:00.000Z");
		stream.publish("idle-1", "attach", "client");
		clock.now = new Date("2026-11-11T13:00:00.000Z");
		expect(lastChangeOfSnapshot(stream, "b")).toMatchObject({
			at: "2026-11-11T12:00:00.000Z",
			cause: "attach",
			by: "client",
		});
	});
});
