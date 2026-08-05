import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	hardCap,
	incrementAccepted,
	shouldRejectByCap,
} from "../../src/core/extensions/builtin/compaction/per-turn-cap.ts";
import { resetTurnCounter } from "../../src/core/extensions/builtin/compaction/state.ts";
import { migrateSessionEntries, parseSessionEntries, type SessionEntry } from "../../src/core/session-manager.ts";

interface FutureCapState {
	acceptedThisTurn: number;
	ineffectiveAttemptsThisTurn?: number;
	acceptedAbsolute: number;
}

type IncrementAcceptedFn = (state: FutureCapState) => FutureCapState;
type ShouldRejectByCapFn = (
	state: FutureCapState,
	opts?: { manual?: boolean; reason?: "manual" | "extension" },
) => { cancel: boolean };
type ResetTurnCounterFn = (state: FutureCapState) => FutureCapState;

const incrementAcceptedFuture = incrementAccepted as unknown as IncrementAcceptedFn;
const shouldRejectByCapFuture = shouldRejectByCap as unknown as ShouldRejectByCapFn;
const resetTurnCounterFuture = resetTurnCounter as unknown as ResetTurnCounterFn;

const REQUIRED_COMPACTIONS_BEFORE_NEXT_ADMISSION = 3;
const EXPECTED_HARD_CAP = 10;

function createInitialCapState(): FutureCapState {
	return { acceptedThisTurn: 0, acceptedAbsolute: 0 };
}

function acceptN(state: FutureCapState, n: number): FutureCapState {
	let next = state;
	for (let i = 0; i < n; i++) {
		next = incrementAcceptedFuture(next);
	}
	return next;
}

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

let perTurnFixtureEntries: SessionEntry[] = [];

beforeAll(() => {
	const fixturePath = join(
		__dirname,
		"..",
		"fixtures",
		"compaction",
		"per-turn-cap",
		"four-back-to-back-compactions.jsonl",
	);
	const content = readFileSync(fixturePath, "utf-8");
	const entries = parseSessionEntries(content);
	migrateSessionEntries(entries);
	perTurnFixtureEntries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
});

describe("compaction admission cap", () => {
	describe("Given three accepted compactions below the absolute hard cap", () => {
		describe("When a fourth required compaction is checked", () => {
			it("Then it is accepted instead of terminating the turn", () => {
				const registration = registerFauxProvider();
				registrations.push(registration);

				const compactionEntries = perTurnFixtureEntries.filter((entry) => entry.type === "compaction");
				expect(compactionEntries.length).toBeGreaterThanOrEqual(REQUIRED_COMPACTIONS_BEFORE_NEXT_ADMISSION + 1);

				const stateAfterThree = acceptN(createInitialCapState(), REQUIRED_COMPACTIONS_BEFORE_NEXT_ADMISSION);
				const decision = shouldRejectByCapFuture(stateAfterThree);

				expect(stateAfterThree.acceptedThisTurn).toBe(REQUIRED_COMPACTIONS_BEFORE_NEXT_ADMISSION);
				expect(stateAfterThree.acceptedAbsolute).toBe(REQUIRED_COMPACTIONS_BEFORE_NEXT_ADMISSION);
				expect(decision).toEqual({ cancel: false });
			});
		});
	});

	describe("Given three ineffective compaction attempts below the absolute hard cap", () => {
		describe("When the next required compaction is checked", () => {
			it("Then it is accepted instead of terminating the turn", () => {
				const stateAfterIneffectiveAttempts: FutureCapState = {
					acceptedThisTurn: 0,
					ineffectiveAttemptsThisTurn: REQUIRED_COMPACTIONS_BEFORE_NEXT_ADMISSION,
					acceptedAbsolute: 0,
				};

				expect(shouldRejectByCapFuture(stateAfterIneffectiveAttempts)).toEqual({ cancel: false });
			});
		});
	});

	describe("Given accepted compactions were recorded this turn", () => {
		describe("When the turn ends and resetTurnCounter is applied", () => {
			it("Then the per-turn counter resets to 0 and the next compaction is accepted", () => {
				const registration = registerFauxProvider();
				registrations.push(registration);

				const stateAtCap = acceptN(createInitialCapState(), REQUIRED_COMPACTIONS_BEFORE_NEXT_ADMISSION);
				expect(shouldRejectByCapFuture(stateAtCap)).toEqual({ cancel: false });

				const stateAfterTurnEnd = resetTurnCounterFuture(stateAtCap);

				expect(stateAfterTurnEnd.acceptedThisTurn).toBe(0);
				expect(shouldRejectByCapFuture(stateAfterTurnEnd)).toEqual({ cancel: false });
			});
		});
	});

	describe("Given accepted compactions are below the absolute hard cap", () => {
		describe("When a manual /compact is checked with manual: true", () => {
			it("Then the manual compaction is accepted", () => {
				const registration = registerFauxProvider();
				registrations.push(registration);

				expect(hardCap).toBe(EXPECTED_HARD_CAP);

				const stateBelowHardCap: FutureCapState = {
					acceptedThisTurn: REQUIRED_COMPACTIONS_BEFORE_NEXT_ADMISSION,
					acceptedAbsolute: REQUIRED_COMPACTIONS_BEFORE_NEXT_ADMISSION,
				};
				expect(shouldRejectByCapFuture(stateBelowHardCap)).toEqual({ cancel: false });

				const manualDecision = shouldRejectByCapFuture(stateBelowHardCap, { manual: true });

				expect(manualDecision).toEqual({ cancel: false });
				expect(stateBelowHardCap.acceptedAbsolute).toBeLessThan(EXPECTED_HARD_CAP);
			});
		});
	});

	describe("Given accepted compactions reach the absolute cap across provider turns", () => {
		it("Then the next automatic compaction is rejected after each soft counter reset", () => {
			let state = createInitialCapState();
			for (let accepted = 0; accepted < EXPECTED_HARD_CAP; accepted++) {
				state = incrementAcceptedFuture(state);
				state = resetTurnCounterFuture(state);
			}

			expect(state.acceptedThisTurn).toBe(0);
			expect(state.acceptedAbsolute).toBe(EXPECTED_HARD_CAP);
			expect(shouldRejectByCapFuture(state)).toEqual({ cancel: true });
			expect(shouldRejectByCapFuture(state, { manual: true })).toEqual({ cancel: true });
			expect(shouldRejectByCapFuture(state, { reason: "manual" })).toEqual({ cancel: true });
			expect(shouldRejectByCapFuture(state, { reason: "extension" })).toEqual({ cancel: true });
		});
	});

	describe("Given compactions were recorded and the session is reloaded with fresh in-memory state", () => {
		describe("When the per-turn counter is read on the reloaded state", () => {
			it("Then the counter is 0 and the next compaction is accepted", () => {
				const registration = registerFauxProvider();
				registrations.push(registration);

				const preReloadState = acceptN(createInitialCapState(), REQUIRED_COMPACTIONS_BEFORE_NEXT_ADMISSION);
				expect(preReloadState.acceptedThisTurn).toBe(REQUIRED_COMPACTIONS_BEFORE_NEXT_ADMISSION);

				const reloadedState = createInitialCapState();

				expect(reloadedState.acceptedThisTurn).toBe(0);
				expect(reloadedState.acceptedAbsolute).toBe(0);
				expect(shouldRejectByCapFuture(reloadedState)).toEqual({ cancel: false });
			});
		});
	});
});
