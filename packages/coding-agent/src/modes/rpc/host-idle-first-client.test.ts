/**
 * senpi#6001: on a coordinated start the idle window waits for the first client, the launcher's readiness probe, for
 * as long as the launcher may still decide the start. A host whose own startup outlasts its idle window otherwise
 * exits before the ensure that started it could probe it (virtual clock).
 */
import { describe, expect, it } from "vitest";
import { IdleExitDecider } from "./host-lifecycle-policy.ts";

const IDLE_MS = 600;
const LAUNCHER_BUDGET_MS = 10_000;
const quiet = { connections: 0, activeTurns: 0 };

describe("idle window before the first client (senpi#6001)", () => {
	it("stays closed until the first client attaches, then counts from its release", () => {
		let now = 0;
		const decider = new IdleExitDecider(IDLE_MS, () => now, LAUNCHER_BUDGET_MS);

		expect(decider.update(quiet)).toBe("active");
		// At startup the observer is not connected yet and counts as one active turn; that is no client.
		expect(decider.update({ connections: 0, activeTurns: 1 })).toBe("active");
		now += LAUNCHER_BUDGET_MS - 1;
		expect(decider.update(quiet)).toBe("active");

		expect(decider.update({ connections: 1, activeTurns: 0 })).toBe("active");
		expect(decider.update(quiet)).toBe("idle");
		now += IDLE_MS - 1;
		expect(decider.update(quiet)).toBe("idle");
		now += 1;
		expect(decider.update(quiet)).toBe("exit");
	});

	it("opens the window once the launcher's budget passed with no client", () => {
		let now = 0;
		const decider = new IdleExitDecider(IDLE_MS, () => now, LAUNCHER_BUDGET_MS);

		expect(decider.update(quiet)).toBe("active");
		now += LAUNCHER_BUDGET_MS;
		expect(decider.update(quiet)).toBe("idle");
		now += IDLE_MS;
		expect(decider.update(quiet)).toBe("exit");
	});
});
