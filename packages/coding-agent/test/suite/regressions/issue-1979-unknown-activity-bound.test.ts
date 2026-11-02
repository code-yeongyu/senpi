import { describe, expect, it } from "vitest";
import { activeTurnsForIdleDecision } from "../../../src/modes/rpc/observer-link.ts";

const GRACE = 15 * 60_000;

describe("issue 1979: how long an unhealthy observer may count as busy", () => {
	it("reports the observed count while the observer is healthy", () => {
		// given: a healthy observer that has seen two busy sessions
		// when: the idle decision asks for the turn count
		const turns = activeTurnsForIdleDecision({
			healthy: true,
			unhealthySince: undefined,
			now: 1_000,
			unknownGraceMs: GRACE,
			observedBusy: 2,
		});

		// then: the truth is reported unchanged
		expect(turns).toBe(2);
	});

	it("pins unknown as busy inside the grace window, so a blip cannot kill a turn", () => {
		// given: an observer that went unhealthy a moment ago
		// when: the idle decision asks before the grace window has elapsed
		const turns = activeTurnsForIdleDecision({
			healthy: false,
			unhealthySince: 1_000,
			now: 1_000 + GRACE - 1,
			unknownGraceMs: GRACE,
			observedBusy: 0,
		});

		// then: unknown still holds the host open
		expect(turns).toBe(1);
	});

	it("stops counting unknown as busy once the grace window has elapsed", () => {
		// given: an observer that has been unhealthy for a whole idle window
		// when: the idle decision asks after the grace window
		const turns = activeTurnsForIdleDecision({
			healthy: false,
			unhealthySince: 1_000,
			now: 1_000 + GRACE,
			unknownGraceMs: GRACE,
			observedBusy: 0,
		});

		// then: the connection count alone decides from here on
		expect(turns).toBe(0);
	});

	it("never expires unknown when the grace window is infinite, which is what persistent means", () => {
		// given: a persistent host whose observer has been unhealthy for a very long time
		// when: the idle decision asks a year later
		const turns = activeTurnsForIdleDecision({
			healthy: false,
			unhealthySince: 0,
			now: 365 * 24 * 60 * 60 * 1000,
			unknownGraceMs: Number.POSITIVE_INFINITY,
			observedBusy: 0,
		});

		// then: persistent still never exits for idleness
		expect(turns).toBe(1);
	});
});
