import { describe, expect, it } from "vitest";
import { combinedToolCallSignal } from "../../src/core/extensions/tool-call-signal.ts";

// senpi#6679 M1: the signal a nested call serves its hooks is the union of the call's own signal and the turn's,
// so aborting either ends the call — and its permission prompt — without aborting either original controller.
describe("combinedToolCallSignal (senpi#6679 M1)", () => {
	it("returns the turn's signal when the call has none", () => {
		const turn = new AbortController().signal;
		expect(combinedToolCallSignal(undefined, turn)).toBe(turn);
	});

	it("returns the call's signal when there is no turn signal", () => {
		const call = new AbortController().signal;
		expect(combinedToolCallSignal(call, undefined)).toBe(call);
	});

	it("returns the same signal when call and turn are one", () => {
		const signal = new AbortController().signal;
		expect(combinedToolCallSignal(signal, signal)).toBe(signal);
	});

	it("aborts when either the call or the turn aborts", () => {
		for (const which of ["call", "turn"] as const) {
			const call = new AbortController();
			const turn = new AbortController();
			const combined = combinedToolCallSignal(call.signal, turn.signal);
			expect(combined).not.toBe(undefined);
			expect(combined?.aborted).toBe(false);
			(which === "call" ? call : turn).abort();
			expect(combined?.aborted).toBe(true);
		}
	});

	it("is born aborted when a member already is", () => {
		const call = new AbortController();
		call.abort();
		const combined = combinedToolCallSignal(call.signal, new AbortController().signal);
		expect(combined?.aborted).toBe(true);
	});
});
