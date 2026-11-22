import { ProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import { describe, expect, it } from "vitest";
import type { RpcSessionEntry } from "../../../src/modes/rpc/session-registry-types.ts";
import { registryStatusSource } from "../../../src/modes/rpc/session-status-source.ts";
import { SessionStatusStream } from "../../../src/modes/rpc/session-status-stream.ts";

const OPTIONS = {
	selector: { kind: "all" },
	includeWorkers: false,
	includeContext: false,
	mirror: { kind: "none" },
	effects: false,
} as const;

function streamAt(clock: { now: Date }) {
	const entry: RpcSessionEntry = {
		state: "open",
		kind: "interactive",
		cwd: "/w",
		attachments: 0,
		context: {},
		scope: new ProviderScope(),
		profile: { cwd: "/w" },
		lastCommandAt: Date.parse("2026-11-11T09:00:00.000Z"),
		lifecycleMutex: Promise.resolve(),
	};
	const stream = new SessionStatusStream({ enqueue: () => true, pendingQuestions: () => 0, now: () => clock.now });
	stream.setSource(registryStatusSource({ list: () => [{ sessionId: "idle-1" }], peek: () => entry }));
	return stream;
}

function lastChangeOfSnapshot(stream: SessionStatusStream, connectionId: string) {
	const { snapshot } = stream.subscribe(connectionId, OPTIONS);
	const record = snapshot.find((row) => row.sessionId === "idle-1");
	if (record === undefined) throw new Error("no snapshot row for idle-1");
	return record.lastChange;
}

describe("session_status snapshot timestamps (senpi#6415)", () => {
	it("reports an idle session's last activity on both subscriptions", () => {
		const clock = { now: new Date("2026-11-11T10:00:00.000Z") };
		const stream = streamAt(clock);
		const first = lastChangeOfSnapshot(stream, "a");
		clock.now = new Date("2026-11-11T11:30:00.000Z");
		const second = lastChangeOfSnapshot(stream, "b");
		expect(first).toEqual({ at: "2026-11-11T09:00:00.000Z", cause: "open", by: "host" });
		expect(second).toEqual(first);
	});

	it("reports the recorded change instead of the last activity", () => {
		const clock = { now: new Date("2026-11-11T10:00:00.000Z") };
		const stream = streamAt(clock);
		lastChangeOfSnapshot(stream, "a");
		clock.now = new Date("2026-11-11T12:00:00.000Z");
		stream.publish("idle-1", "attach", "client");
		clock.now = new Date("2026-11-11T13:00:00.000Z");
		expect(lastChangeOfSnapshot(stream, "b")).toEqual({
			at: "2026-11-11T12:00:00.000Z",
			cause: "attach",
			by: "client",
		});
	});
});
