import { describe, expect, it } from "vitest";
import {
	createFallbackCircuitAccess,
	type FallbackCircuitAccess,
	FallbackCircuitBreaker,
} from "../../src/core/retry-fallback/circuit.ts";

const SELECTOR = "faux/faux-1";
const WALL_EPOCH = Date.UTC(2026, 9, 14, 16, 47);
const MINUTE = 60_000;
const silentLogger = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };

function circuitAt(clock: { mono: number; wall: number }): FallbackCircuitAccess {
	return createFallbackCircuitAccess({
		breaker: new FallbackCircuitBreaker(),
		owner: () => "session",
		now: () => clock.mono,
		wallNow: () => clock.wall,
		settings: () => ({ cooldownMs: MINUTE, maxCooldownMs: 30 * MINUTE }),
		logger: silentLogger,
	});
}

const sessionLimitResetIn = (minutes: number) =>
	`Devin stream error resource_exhausted: Reached free model rate limit. Upgrade to Max for higher limits, or switch to a different model. Your limit will reset in ${minutes} minutes.`;

describe("senpi#3303 the circuit honors a usage limit's reset window and nothing shorter", () => {
	it("#given three usage-limit failures naming a 2-minute reset #when 2.5 minutes pass #then the primary is admitted again", () => {
		const clock = { mono: 0, wall: WALL_EPOCH };
		const circuit = circuitAt(clock);
		for (let i = 0; i < 3; i++) circuit.noteFailure(SELECTOR, { errorMessage: sessionLimitResetIn(2) });

		clock.mono += 2.5 * MINUTE;
		clock.wall += 2.5 * MINUTE;

		expect(circuit.isOpen(SELECTOR)).toBe(false);
	});

	it("#given a usage limit naming a 20-minute reset #when the 1-minute cooldown passes #then it stays open until the reset", () => {
		const clock = { mono: 0, wall: WALL_EPOCH };
		const circuit = circuitAt(clock);
		circuit.noteFailure(SELECTOR, { errorMessage: sessionLimitResetIn(20) });

		clock.mono += 10 * MINUTE;
		expect(circuit.isOpen(SELECTOR)).toBe(true);
		clock.mono += 11 * MINUTE;
		expect(circuit.isOpen(SELECTOR)).toBe(false);
	});

	it.each([
		["a Retry-After header", { retryAfterMs: 1_000 }],
		["a 'try again in 2s' rate limit", { errorMessage: "429 Too Many Requests: please try again in 2s" }],
		["an overload asking to retry in 1 second", { errorMessage: "overloaded, retry in 1 second" }],
		[
			"a spent quota asking to retry in 7s",
			{
				errorMessage:
					"429 You exceeded your current quota, please check your plan and billing details. Please retry in 7s.",
			},
		],
		[
			"a usage limit asking to try again in 3 seconds",
			{ errorMessage: "You've hit your usage limit. Try again in 3 seconds." },
		],
		["a usage limit asking to retry in 2s", { errorMessage: "You've hit your usage limit. Please retry in 2s." }],
		[
			"a usage limit resetting in 30 seconds",
			{ errorMessage: "You've hit your usage limit. Your limit will reset in 30 seconds." },
		],
	])("#given repeated failures with %s #then the open keeps the doubling cooldown floor", (_label, failure) => {
		const clock = { mono: 0, wall: WALL_EPOCH };
		const circuit = circuitAt(clock);
		const closesAfter: number[] = [];
		for (let i = 0; i < 3; i++) {
			const openedAt = clock.mono;
			circuit.noteFailure(SELECTOR, failure);
			while (circuit.isOpen(SELECTOR)) clock.mono += 1_000;
			closesAfter.push(clock.mono - openedAt);
		}

		expect(closesAfter).toEqual([MINUTE, 2 * MINUTE, 4 * MINUTE]);
	});

	it("#given a running Retry-After wait #when a usage limit names a shorter reset #then the open keeps the wait", () => {
		const clock = { mono: 0, wall: WALL_EPOCH };
		const circuit = circuitAt(clock);
		circuit.noteFailure(SELECTOR, { retryAfterMs: 10 * MINUTE });
		circuit.noteFailure(SELECTOR, { errorMessage: sessionLimitResetIn(2) });

		clock.mono += 5 * MINUTE;
		expect(circuit.isOpen(SELECTOR)).toBe(true);
	});

	it("#given a usage limit whose absolute reset is 30 seconds away #then the open ends at that reset", () => {
		const clock = { mono: 0, wall: WALL_EPOCH };
		const circuit = circuitAt(clock);
		circuit.noteFailure(SELECTOR, {
			errorMessage: `429 {"error":{"type":"usage_limit_reached","resets_at":${WALL_EPOCH / 1000 + 30}}}`,
		});

		clock.mono += 31_000;
		expect(circuit.isOpen(SELECTOR)).toBe(false);
	});

	it("#given a monotonic clock that drifted from the wall clock after sleep #when a resets_at time is parsed #then the window follows the wall clock", () => {
		const clock = { mono: 5_000, wall: WALL_EPOCH };
		const circuit = circuitAt(clock);
		const resetsAt = WALL_EPOCH / 1000 + 120;
		circuit.noteFailure(SELECTOR, {
			errorMessage: `429 {"error":{"type":"usage_limit_reached","resets_at":${resetsAt}}}`,
		});

		clock.mono += 100_000;
		expect(circuit.isOpen(SELECTOR)).toBe(true);
		clock.mono += 30_000;
		expect(circuit.isOpen(SELECTOR)).toBe(false);
	});
});
