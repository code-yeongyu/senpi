import { describe, expect, it } from "vitest";
import { buildTurn } from "../../../src/modes/app-server/threads/turn-runtime.ts";
import { buildWireThread, loggedTurnToWireTurn } from "../../../src/modes/app-server/threads/wire-thread.ts";
import type { WireThread } from "../../../src/modes/app-server/threads/registry.ts";
import { TurnLog, type LoggedTurn } from "../../../src/modes/app-server/threads/turn-log.ts";

const wireThread: WireThread = {
	id: "thread-1",
	sessionId: "session-1",
	sessionPath: "/tmp/senpi-codex-integer-timestamps.session",
	cwd: process.cwd(),
	createdAt: "2026-07-20T00:00:00.125Z",
	updatedAt: "2026-07-20T00:00:01.250Z",
	status: { type: "idle" },
	preview: null,
	name: null,
};

const loggedTurn: LoggedTurn = {
	turnId: "turn-1",
	rollbackLeafId: null,
	startedAt: "2026-07-20T00:00:00.125Z",
	completedAt: "2026-07-20T00:00:01.250Z",
	durationMs: 1_125,
	error: null,
	status: "completed",
	items: [],
};

describe("Codex app-server integer timestamps", () => {
	it("returns integer thread timestamps for millisecond-bearing and invalid ISO values", async () => {
		// Given: a wire thread with millisecond-bearing timestamps and an invalid recency timestamp.
		// When: the public thread projection builds the app-server response.
		const projected = await buildWireThread(wireThread, new TurnLog(), false, {
			recencyAt: "not-an-iso-date",
		});

		// Then: all thread timestamp fields are integer epoch seconds, with invalid input as zero.
		expect(projected.createdAt).toBe(1_784_505_600);
		expect(projected.updatedAt).toBe(1_784_505_601);
		expect(projected.recencyAt).toBe(0);
		expect(Number.isInteger(projected.createdAt)).toBe(true);
		expect(Number.isInteger(projected.updatedAt)).toBe(true);
		expect(Number.isInteger(projected.recencyAt)).toBe(true);

		const invalid = await buildWireThread(
			{ ...wireThread, createdAt: "invalid", updatedAt: "invalid" },
			new TurnLog(),
			false,
		);
		expect(invalid.createdAt).toBe(0);
		expect(invalid.updatedAt).toBe(0);
	});

	it("returns integer turn timestamps for millisecond-bearing and invalid ISO values", () => {
		// Given: a logged turn whose lifecycle timestamps include milliseconds.
		// When: the public turn projection builds the app-server response.
		const projected = loggedTurnToWireTurn(loggedTurn);

		// Then: both turn timestamp fields are integer epoch seconds.
		expect(projected.startedAt).toBe(1_784_505_600);
		expect(projected.completedAt).toBe(1_784_505_601);
		expect(Number.isInteger(projected.startedAt)).toBe(true);
		expect(Number.isInteger(projected.completedAt)).toBe(true);

		// Given: invalid lifecycle timestamps.
		// When: the public turn projection handles them.
		const invalid = loggedTurnToWireTurn({ ...loggedTurn, startedAt: "invalid", completedAt: "invalid" });

		// Then: invalid timestamps use the wire fallback zero.
		expect(invalid.startedAt).toBe(0);
		expect(invalid.completedAt).toBe(0);
	});

	it("returns integer timestamps for live in-process turns", () => {
		// Given: a live turn with millisecond epoch inputs and no completion yet.
		// When: the live turn wire payload is built.
		const inProgress = buildTurn("turn-live", "inProgress", 1_784_505_600_125, null, []);

		// Then: startedAt is an integer and completedAt remains null.
		expect(inProgress.startedAt).toBe(1_784_505_600);
		expect(Number.isInteger(inProgress.startedAt)).toBe(true);
		expect(inProgress.completedAt).toBeNull();

		// Given: the same turn completes at a millisecond-bearing epoch time.
		// When: the completed live payload is built.
		const completed = buildTurn("turn-live", "completed", 1_784_505_600_125, 1_784_505_601_250, []);

		// Then: both live timestamp fields are integer epoch seconds.
		expect(completed.startedAt).toBe(1_784_505_600);
		expect(completed.completedAt).toBe(1_784_505_601);
		expect(Number.isInteger(completed.startedAt)).toBe(true);
		expect(Number.isInteger(completed.completedAt)).toBe(true);
	});
});
