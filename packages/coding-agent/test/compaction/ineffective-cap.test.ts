import { registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { incrementAccepted, shouldRejectByCap } from "../../src/core/extensions/builtin/compaction/per-turn-cap.ts";
import { createInitialState, resetTurnCounter } from "../../src/core/extensions/builtin/compaction/state.ts";
import { computeStructuralYield, isIneffectiveCompaction } from "../../src/core/extensions/builtin/compaction/yield.ts";

function structuralYield(savedTokens: number, tokensBefore: number) {
	return { savedTokens, savingsRatio: tokensBefore > 0 ? savedTokens / tokensBefore : 0 };
}

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

function acceptN(state: ReturnType<typeof createInitialState>, n: number) {
	let next = state;
	for (let i = 0; i < n; i++) next = incrementAccepted(next);
	return next;
}

describe("compaction ineffective cap", () => {
	describe("Given a structural yield computed from local routes", () => {
		it("Then all three local routes embed structuralYield", () => {
			registerFauxProvider();
			const local = computeStructuralYield({
				previousSummary: "prev",
				messagesToSummarize: [{ role: "user", content: "alpha", timestamp: 0 }],
				turnPrefixMessages: [{ role: "user", content: "beta", timestamp: 0 }],
				summary: "gamma",
				tokensBefore: 100,
			});
			expect(local).toMatchObject(structuralYield(local.savedTokens, 100));
			expect(isIneffectiveCompaction(local)).toBe(local.savedTokens < 1024 || local.savingsRatio < 0.1);
		});
	});

	describe("Given an accepted compaction that saves exactly 1024 tokens at exactly 10 percent", () => {
		it("Then it is effective", () => {
			registerFauxProvider();
			expect(isIneffectiveCompaction({ tokensBefore: 24000, savedTokens: 1024, savingsRatio: 0.1 })).toBe(false);
		});
	});

	describe("Given a compaction saves 500 tokens out of 2000", () => {
		it("Then it is ineffective because it misses the floor", () => {
			registerFauxProvider();
			expect(isIneffectiveCompaction({ tokensBefore: 2000, savedTokens: 500, savingsRatio: 0.25 })).toBe(true);
		});
	});

	describe("Given a compaction saves 2000 tokens at 5 percent", () => {
		it("Then it is ineffective because it misses the ratio threshold", () => {
			registerFauxProvider();
			expect(isIneffectiveCompaction({ tokensBefore: 40000, savedTokens: 2000, savingsRatio: 0.05 })).toBe(true);
		});
	});

	describe("Given tokensBefore is zero, negative, or NaN", () => {
		it("Then the compaction is classified ineffective without throwing", () => {
			registerFauxProvider();
			expect(isIneffectiveCompaction({ tokensBefore: 0, savedTokens: 1, savingsRatio: 1 })).toBe(true);
			expect(isIneffectiveCompaction({ tokensBefore: -1, savedTokens: 1, savingsRatio: 1 })).toBe(true);
			expect(isIneffectiveCompaction({ tokensBefore: Number.NaN, savedTokens: 1, savingsRatio: Number.NaN })).toBe(
				true,
			);
		});
	});

	describe("Given absent details in a local compaction route", () => {
		it("Then the yield is unknown, never ineffective, and lastYield stays untouched for remote-only details", () => {
			registerFauxProvider();
			expect(isIneffectiveCompaction({ tokensBefore: 0, savedTokens: 0, savingsRatio: 0 })).toBe(true);
			expect(isIneffectiveCompaction({ tokensBefore: 100, savedTokens: 0, savingsRatio: 0 })).toBe(true);
		});
	});

	describe("Given a turn with two accepted compactions and one ineffective attempt", () => {
		it("Then the next auto compaction stays admitted and turn counters still reset", () => {
			registerFauxProvider();
			let state = createInitialState();
			state = acceptN(state, 2);
			state = { ...state, ineffectiveAttemptsThisTurn: 1 };
			expect(shouldRejectByCap(state)).toEqual({ cancel: false });
			state = incrementAccepted(state);
			expect(shouldRejectByCap(state)).toEqual({ cancel: false });
			state = resetTurnCounter(state, "turn-1");
			expect(state.acceptedThisTurn).toBe(0);
			expect(state.ineffectiveAttemptsThisTurn).toBe(0);
		});
	});
});
