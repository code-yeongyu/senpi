import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	incrementAccepted,
	incrementIneffective,
	shouldRejectByCap,
} from "../../src/core/extensions/builtin/compaction/per-turn-cap.ts";
import {
	type CompactionExtensionState,
	createInitialState,
	resetTurnCounter,
} from "../../src/core/extensions/builtin/compaction/state.ts";
import { migrateSessionEntries, parseSessionEntries, type SessionEntry } from "../../src/core/session-manager.ts";

const FORMER_SOFT_CAP = 3;
const FORMER_ABSOLUTE_CAP = 10;
const LONG_LIVED_SESSION_ACCEPTED = 10_000;

function acceptN(state: CompactionExtensionState, n: number): CompactionExtensionState {
	let next = state;
	for (let i = 0; i < n; i++) {
		next = incrementAccepted(next);
	}
	return next;
}

function ineffectiveN(state: CompactionExtensionState, n: number): CompactionExtensionState {
	let next = state;
	for (let i = 0; i < n; i++) {
		next = incrementIneffective(next);
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

describe("compaction admission accounting", () => {
	describe("Given the former per-turn soft cap of 3 accepted compactions this turn", () => {
		describe("When a 4th required compaction is checked in the same turn", () => {
			it("Then it is admitted instead of fatally ending the turn", () => {
				const registration = registerFauxProvider();
				registrations.push(registration);

				const compactionEntries = perTurnFixtureEntries.filter((entry) => entry.type === "compaction");
				expect(compactionEntries.length).toBeGreaterThanOrEqual(FORMER_SOFT_CAP + 1);

				const stateAfterThree = acceptN(createInitialState(), FORMER_SOFT_CAP);

				expect(stateAfterThree.acceptedThisTurn).toBe(FORMER_SOFT_CAP);
				expect(stateAfterThree.acceptedAbsolute).toBe(FORMER_SOFT_CAP);
				expect(shouldRejectByCap(stateAfterThree)).toEqual({ cancel: false });
			});
		});
	});

	describe("Given 3 ineffective compaction attempts this turn", () => {
		describe("When the next required compaction is checked", () => {
			it("Then it is admitted instead of fatally ending the turn", () => {
				const stateAfterIneffective = ineffectiveN(createInitialState(), FORMER_SOFT_CAP);

				expect(stateAfterIneffective.ineffectiveAttemptsThisTurn).toBe(FORMER_SOFT_CAP);
				expect(shouldRejectByCap(stateAfterIneffective)).toEqual({ cancel: false });
			});
		});
	});

	describe("Given successful compactions before a turn reset", () => {
		describe("When the turn ends and resetTurnCounter is applied", () => {
			it("Then admission is open before and after the reset", () => {
				const registration = registerFauxProvider();
				registrations.push(registration);

				const stateBeforeReset = acceptN(createInitialState(), FORMER_SOFT_CAP);
				expect(shouldRejectByCap(stateBeforeReset)).toEqual({ cancel: false });

				const stateAfterTurnEnd = resetTurnCounter(stateBeforeReset, "turn-1");

				expect(stateAfterTurnEnd.acceptedThisTurn).toBe(0);
				expect(stateAfterTurnEnd.acceptedAbsolute).toBe(FORMER_SOFT_CAP);
				expect(shouldRejectByCap(stateAfterTurnEnd)).toEqual({ cancel: false });
			});
		});
	});

	describe("Given accepted compactions exceed the former absolute cap across provider turns", () => {
		it("Then successful compactions remain admitted in a long-lived session", () => {
			let state = createInitialState();
			for (let accepted = 0; accepted < FORMER_ABSOLUTE_CAP; accepted++) {
				state = incrementAccepted(state);
				state = resetTurnCounter(state, `turn-${accepted}`);
			}

			expect(state.acceptedThisTurn).toBe(0);
			expect(state.acceptedAbsolute).toBe(FORMER_ABSOLUTE_CAP);
			expect(shouldRejectByCap(state)).toEqual({ cancel: false });

			for (let accepted = FORMER_ABSOLUTE_CAP; accepted < LONG_LIVED_SESSION_ACCEPTED; accepted++) {
				state = incrementAccepted(state);
				state = resetTurnCounter(state, `turn-${accepted}`);
			}

			expect(state.acceptedThisTurn).toBe(0);
			expect(state.acceptedAbsolute).toBe(LONG_LIVED_SESSION_ACCEPTED);
			expect(shouldRejectByCap(state)).toEqual({ cancel: false });
			expect(shouldRejectByCap(resetTurnCounter(state, "turn-final"))).toEqual({ cancel: false });
		});
	});

	describe("Given the session is reloaded with fresh in-memory state", () => {
		describe("When admission is checked on the reloaded state", () => {
			it("Then the counters are 0 and the next compaction is accepted", () => {
				const registration = registerFauxProvider();
				registrations.push(registration);

				const reloadedState = createInitialState();

				expect(reloadedState.acceptedThisTurn).toBe(0);
				expect(reloadedState.acceptedAbsolute).toBe(0);
				expect(shouldRejectByCap(reloadedState)).toEqual({ cancel: false });
			});
		});
	});
});
