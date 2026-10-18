import { describe, expect, it } from "vitest";
import { IdleExitDecider } from "../../src/modes/rpc/host-lifecycle.ts";

function clock(start = 0) {
	let now = start;
	return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("issue 1979: the idle window contract a bounded fail-open must preserve", () => {
	it("treats any attachment as active and restarts the window", () => {
		// given: a decider with a 1s window
		const time = clock();
		const decider = new IdleExitDecider(1_000, time.now);

		// when: a connection is present, then leaves after most of the window has passed
		expect(decider.update({ connections: 1, activeTurns: 0 })).toBe("active");
		time.advance(900);
		expect(decider.update({ connections: 1, activeTurns: 0 })).toBe("active");
		time.advance(900);

		// then: the window starts from the detach, so the earlier wait does not count
		expect(decider.update({ connections: 0, activeTurns: 0 })).toBe("idle");
		time.advance(999);
		expect(decider.update({ connections: 0, activeTurns: 0 })).toBe("idle");
		time.advance(1);
		expect(decider.update({ connections: 0, activeTurns: 0 })).toBe("exit");
	});

	it("treats any active turn as active, which is what the unhealthy-observer pin relies on", () => {
		// given: a decider whose window has already started
		const time = clock();
		const decider = new IdleExitDecider(1_000, time.now);
		expect(decider.update({ connections: 0, activeTurns: 0 })).toBe("idle");
		time.advance(999);

		// when: a turn is reported with no connections at all
		expect(decider.update({ connections: 0, activeTurns: 1 })).toBe("active");
		time.advance(999);

		// then: the window restarted, so the host is still held open
		expect(decider.update({ connections: 0, activeTurns: 0 })).toBe("idle");
	});

	it("never exits when the window is infinite, however long it stays idle", () => {
		// given: the persistent cold-start policy
		const time = clock();
		const decider = new IdleExitDecider(Number.POSITIVE_INFINITY, time.now);

		// when: it sits idle for a very long time
		expect(decider.update({ connections: 0, activeTurns: 0 })).toBe("idle");
		time.advance(365 * 24 * 60 * 60 * 1000);

		// then: persistent still means "do not exit for idleness"
		expect(decider.update({ connections: 0, activeTurns: 0 })).toBe("idle");
	});
});
