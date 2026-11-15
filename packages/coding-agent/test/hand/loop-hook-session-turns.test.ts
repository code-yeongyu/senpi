// #6751 follow-up (#6770 review L1): what a hand keeps per loop session to answer whether it is still idle after a
// turn. It keeps a session only while something can read it: the turn-ending call while it runs, then a held Stop
// until it settles. A turn seen running ends the idleness and forgets the session.
import { describe, expect, it } from "vitest";
import { createSessionTurns } from "../../src/modes/rpc/loop-hook-session-turns.ts";

describe("a hand's view of its loop sessions' turns", () => {
	it("forgets a session whose turn-ending call held nothing once the call returns", () => {
		const turns = createSessionTurns();
		const during = Array.from({ length: 100 }, (_, index) => turns.ending(`session-${index}`));
		const whileCallsRun = turns.size;

		for (const turnEnd of during) turnEnd.callEnded();

		expect({ whileCallsRun, afterCalls: turns.size }).toEqual({ whileCallsRun: 100, afterCalls: 0 });
	});

	it("keeps a finished session while its held Stop waits, and forgets it once the Stop settles", () => {
		const turns = createSessionTurns();
		const turnEnd = turns.ending("finished");
		const release = turnEnd.hold();
		turnEnd.callEnded();
		const whileHeld = { held: turns.size, idle: turnEnd.idle() };

		release();
		release();

		expect({ whileHeld, afterSettled: turns.size }).toEqual({ whileHeld: { held: 1, idle: true }, afterSettled: 0 });
	});

	it("on a turn seen running, answers busy to every held turn end of that session only, and forgets it", () => {
		const turns = createSessionTurns();
		const first = turns.ending("a");
		const second = turns.ending("a");
		const other = turns.ending("b");
		const holds = [first.hold(), second.hold(), other.hold()];
		for (const turnEnd of [first, second, other]) turnEnd.callEnded();

		turns.running("a");
		const afterRunning = { first: first.idle(), second: second.idle(), other: other.idle(), kept: turns.size };
		for (const release of holds) release();

		expect({ afterRunning, afterSettled: turns.size }).toEqual({
			afterRunning: { first: false, second: false, other: true, kept: 1 },
			afterSettled: 0,
		});
	});
});
