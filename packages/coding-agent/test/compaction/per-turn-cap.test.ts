import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerFauxProvider } from "@mariozechner/pi-ai";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	hardCap,
	incrementAccepted,
	shouldRejectByCap,
	softCap,
} from "../../src/core/extensions/builtin/compaction/per-turn-cap.js";
import { resetTurnCounter } from "../../src/core/extensions/builtin/compaction/state.js";
import { migrateSessionEntries, parseSessionEntries, type SessionEntry } from "../../src/core/session-manager.js";

interface FutureCapState {
	acceptedThisTurn: number;
	acceptedAbsolute: number;
}

type IncrementAcceptedFn = (state: FutureCapState) => FutureCapState;
type ShouldRejectByCapFn = (state: FutureCapState, opts?: { manual?: boolean }) => { cancel: boolean };
type ResetTurnCounterFn = (state: FutureCapState) => FutureCapState;

const incrementAcceptedFuture = incrementAccepted as unknown as IncrementAcceptedFn;
const shouldRejectByCapFuture = shouldRejectByCap as unknown as ShouldRejectByCapFn;
const resetTurnCounterFuture = resetTurnCounter as unknown as ResetTurnCounterFn;

const EXPECTED_SOFT_CAP = 3;
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

describe("compaction per-turn cap", () => {
	describe("Given a fresh turn with the soft cap of 3 accepted compactions", () => {
		describe("When 3 compactions are accepted and a 4th is checked", () => {
			it("Then the 4th compaction is rejected with { cancel: true }", () => {
				const registration = registerFauxProvider();
				registrations.push(registration);

				expect(softCap).toBe(EXPECTED_SOFT_CAP);
				const compactionEntries = perTurnFixtureEntries.filter((entry) => entry.type === "compaction");
				expect(compactionEntries.length).toBeGreaterThanOrEqual(EXPECTED_SOFT_CAP + 1);

				const stateAfterThree = acceptN(createInitialCapState(), EXPECTED_SOFT_CAP);
				const decision = shouldRejectByCapFuture(stateAfterThree);

				expect(stateAfterThree.acceptedThisTurn).toBe(EXPECTED_SOFT_CAP);
				expect(decision).toEqual({ cancel: true });
			});
		});
	});

	describe("Given the soft cap has been reached this turn", () => {
		describe("When the turn ends and resetTurnCounter is applied", () => {
			it("Then the per-turn counter resets to 0 and the next compaction is accepted", () => {
				const registration = registerFauxProvider();
				registrations.push(registration);

				const stateAtCap = acceptN(createInitialCapState(), EXPECTED_SOFT_CAP);
				expect(shouldRejectByCapFuture(stateAtCap)).toEqual({ cancel: true });

				const stateAfterTurnEnd = resetTurnCounterFuture(stateAtCap);

				expect(stateAfterTurnEnd.acceptedThisTurn).toBe(0);
				expect(shouldRejectByCapFuture(stateAfterTurnEnd)).toEqual({ cancel: false });
			});
		});
	});

	describe("Given the soft cap has been reached and the absolute hard cap is 10", () => {
		describe("When a manual /compact is checked with manual: true", () => {
			it("Then the cap is bypassed and the manual compaction is accepted", () => {
				const registration = registerFauxProvider();
				registrations.push(registration);

				expect(hardCap).toBe(EXPECTED_HARD_CAP);

				const stateAtSoftCap: FutureCapState = {
					acceptedThisTurn: EXPECTED_SOFT_CAP,
					acceptedAbsolute: EXPECTED_SOFT_CAP,
				};
				expect(shouldRejectByCapFuture(stateAtSoftCap)).toEqual({ cancel: true });

				const manualDecision = shouldRejectByCapFuture(stateAtSoftCap, { manual: true });

				expect(manualDecision).toEqual({ cancel: false });
				expect(stateAtSoftCap.acceptedAbsolute).toBeLessThan(EXPECTED_HARD_CAP);
			});
		});
	});

	describe("Given the soft cap was reached and the session is reloaded with fresh in-memory state", () => {
		describe("When the per-turn counter is read on the reloaded state", () => {
			it("Then the counter is 0 and the next compaction is accepted", () => {
				const registration = registerFauxProvider();
				registrations.push(registration);

				const preReloadState = acceptN(createInitialCapState(), EXPECTED_SOFT_CAP);
				expect(preReloadState.acceptedThisTurn).toBe(EXPECTED_SOFT_CAP);

				const reloadedState = createInitialCapState();

				expect(reloadedState.acceptedThisTurn).toBe(0);
				expect(reloadedState.acceptedAbsolute).toBe(0);
				expect(shouldRejectByCapFuture(reloadedState)).toEqual({ cancel: false });
			});
		});
	});
});
