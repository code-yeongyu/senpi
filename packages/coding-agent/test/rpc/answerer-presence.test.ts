// senpi#7572 no hang: a raised prompt in a run whose answerer left is settled after the grace, on a virtual clock.
import { describe, expect, it } from "vitest";
import { ANSWERER_GRACE_MS, AnswererPresence, type Schedule } from "../../src/modes/rpc/answerer-presence.ts";

function virtualClock() {
	const timers = new Map<number, { at: number; run: () => void }>();
	let now = 0;
	let next = 0;
	const schedule: Schedule = (run, ms) => {
		const id = ++next;
		timers.set(id, { at: now + ms, run });
		return () => timers.delete(id);
	};
	const advance = (ms: number) => {
		now += ms;
		for (const [id, timer] of [...timers]) {
			if (timer.at > now) continue;
			timers.delete(id);
			timer.run();
		}
	};
	return { schedule, advance, pending: () => timers.size };
}

describe("AnswererPresence", () => {
	it("reports nothing for a run whose answerer never left", () => {
		const presence = new AnswererPresence(() => {}, virtualClock().schedule);
		expect(presence.answerer()).toBeUndefined();
	});

	it("reports absent at once and settles raised prompts once, at the grace bound", () => {
		const clock = virtualClock();
		let settled = 0;
		const presence = new AnswererPresence(() => settled++, clock.schedule);
		presence.set(false);
		expect(presence.answerer()).toBe("absent");
		clock.advance(ANSWERER_GRACE_MS - 1);
		expect(settled).toBe(0);
		clock.advance(1);
		expect(settled).toBe(1);
		presence.set(false);
		clock.advance(ANSWERER_GRACE_MS);
		expect(settled).toBe(1);
	});

	it("keeps raised prompts when the answerer comes back within the grace", () => {
		const clock = virtualClock();
		let settled = 0;
		const presence = new AnswererPresence(() => settled++, clock.schedule);
		presence.set(false);
		clock.advance(ANSWERER_GRACE_MS - 1);
		presence.set(true);
		expect(presence.answerer()).toBeUndefined();
		clock.advance(ANSWERER_GRACE_MS);
		expect(settled).toBe(0);
		expect(clock.pending()).toBe(0);
	});
});
