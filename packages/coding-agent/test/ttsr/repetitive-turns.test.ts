import { describe, expect, it } from "vitest";

import {
	createRepetitiveTurnsState,
	normalizeTurnText,
	REPETITIVE_TURNS_RULE_NAME,
	recordTurnText,
	trigramJaccard,
} from "../../src/core/extensions/builtin/ttsr/detectors/repetitive-turns.ts";

const SESSION_STATUS_VARIANTS = [
	"I read this as continue supervising the portable-PTY matrix; it has started cleanly with 1 check green and 8 pending.",
	"I read this as continue supervising the portable-PTY matrix; it has started cleanly with 2 checks green and 7 pending.",
	"I read this as continue supervising the portable-PTY matrix; it has started cleanly with 3 checks green and 6 pending.",
	"I read this as continue supervising the portable-PTY matrix; it has started cleanly with 4 checks green and 5 pending.",
];

describe("normalizeTurnText", () => {
	it("lowercases and folds digits, timestamps, and hex-like ids", () => {
		expect(normalizeTurnText("3 checks Green, 6 remain at 06:08:27")).toBe("# checks green, # remain at #");
		expect(normalizeTurnText("run 30882887316 on head 9a201e8 done")).toBe("run # on head # done");
	});

	it("collapses whitespace runs", () => {
		expect(normalizeTurnText("a   b\tc\nd")).toBe("a b c d");
	});
});

describe("trigramJaccard", () => {
	it("is 1 for identical normalized texts and 0 for disjoint ones", () => {
		const a = normalizeTurnText(SESSION_STATUS_VARIANTS[0]);
		expect(trigramJaccard(a, a)).toBe(1);
		expect(trigramJaccard("alpha beta gamma delta epsilon", "one two three four five")).toBe(0);
	});

	it("matches near-duplicates that are not identical after normalization", () => {
		const a = normalizeTurnText("Still working on the frobnicate step. Pass 1 of 9 is done, queue drained here.");
		const b = normalizeTurnText("Still working on the frobnicate step. Pass 2 of 9 is done, queue drained again.");
		expect(a).not.toBe(b);
		expect(trigramJaccard(a, b)).toBeGreaterThanOrEqual(0.55);
	});

	it("scores the session-019fca2b status variants as highly similar", () => {
		const normalized = SESSION_STATUS_VARIANTS.map(normalizeTurnText);
		for (let i = 1; i < normalized.length; i++) {
			expect(trigramJaccard(normalized[i - 1], normalized[i])).toBeGreaterThanOrEqual(0.55);
		}
	});

	it("scores genuinely different updates as dissimilar", () => {
		const a = normalizeTurnText(SESSION_STATUS_VARIANTS[0]);
		const b = normalizeTurnText(
			"The run completed by hitting the Windows job timeout at the limit; both Windows jobs were cancelled, not assertion-failed.",
		);
		expect(trigramJaccard(a, b)).toBeLessThan(0.35);
	});
});

// Handoff blocks restate the user's request after `Ask:` by contract (senpi#2135); recorded from a grok-4.7 run.
const RESTATED_ASK =
	"Ask: Add a slugify(title) helper in src/slug.ts, use it in src/index.ts to print slugs for the three sample titles, and add a test file that covers unicode and repeated dashes. — wanted: helper, printed slugs, unicode/dash tests.";
const MID_TASK_HANDOFF = `${RESTATED_ASK} For you: source is a three-title loop with no helper yet. Now: Add slugify helper. Next: Wire slugify into index.`;
const FINAL_HANDOFF_PREFIX = `${RESTATED_ASK} For you:`;

describe("handoff blocks (senpi#2135)", () => {
	it("does not score the restated Ask clause of a new handoff block as a repeat of the previous block", () => {
		// given: the prefix the stream carried when the final block was aborted
		// when/then
		expect(trigramJaccard(normalizeTurnText(FINAL_HANDOFF_PREFIX), normalizeTurnText(MID_TASK_HANDOFF))).toBeLessThan(
			0.55,
		);
	});

	it("keeps an Ask: that no status label closes, so a looping turn containing it still repeats (senpi#2143)", () => {
		// given: a stuck turn that mentions Ask: but is not a handoff block
		const loop = "Ask: me anything. I am still waiting for the build to finish before I run the parser tests again.";
		const state = createRepetitiveTurnsState();

		// when
		const matches = [recordTurnText(state, loop), recordTurnText(state, loop), recordTurnText(state, loop)];

		// then
		expect(normalizeTurnText(loop)).toContain("still waiting for the build");
		expect(matches[2]?.rule).toBe(REPETITIVE_TURNS_RULE_NAME);
	});

	it("still scores two blocks with the same status as near-duplicates", () => {
		// given: a model re-emitting the same For you / Now / Next under the same Ask
		const again = `${RESTATED_ASK} For you: source is a three-title loop with no helper yet. Now: Add slugify helper. Next: Wire slugify into index.`;
		// when/then
		expect(trigramJaccard(normalizeTurnText(again), normalizeTurnText(MID_TASK_HANDOFF))).toBeGreaterThanOrEqual(
			0.55,
		);
	});
});

describe("repetitive-turns detector", () => {
	it("does not fire on the first two similar turns, then fires on the third consecutive near-duplicate", () => {
		const state = createRepetitiveTurnsState();
		expect(recordTurnText(state, SESSION_STATUS_VARIANTS[0])).toBeNull();
		expect(recordTurnText(state, SESSION_STATUS_VARIANTS[1])).toBeNull();
		const match = recordTurnText(state, SESSION_STATUS_VARIANTS[2]);
		expect(match).not.toBeNull();
		expect(match?.rule).toBe(REPETITIVE_TURNS_RULE_NAME);
		expect(match?.detail.mechanism).toBe("cross-turn");
	});

	it("stays silent for genuinely changing updates", () => {
		const state = createRepetitiveTurnsState();
		expect(recordTurnText(state, SESSION_STATUS_VARIANTS[0])).toBeNull();
		expect(
			recordTurnText(
				state,
				"The two reds are again Linux jobs while Windows and macOS x64 remain active. I am switching to a run-level watcher for the current head.",
			),
		).toBeNull();
		expect(
			recordTurnText(
				state,
				"Windows now passes the PTY integration binary; the next store tests hardcode a shell path. I am gating only the live lifecycle cases.",
			),
		).toBeNull();
		expect(
			recordTurnText(state, "All checks are green; merging the pull request and cleaning up the worktree now."),
		).toBeNull();
	});

	it("ignores texts below the minimum length floor even when identical", () => {
		const state = createRepetitiveTurnsState();
		expect(recordTurnText(state, "ok")).toBeNull();
		expect(recordTurnText(state, "ok")).toBeNull();
		expect(recordTurnText(state, "ok")).toBeNull();
	});

	it("suppresses refiring while latched and resets on a dissimilar turn", () => {
		const state = createRepetitiveTurnsState();
		recordTurnText(state, SESSION_STATUS_VARIANTS[0]);
		recordTurnText(state, SESSION_STATUS_VARIANTS[1]);
		expect(recordTurnText(state, SESSION_STATUS_VARIANTS[2])).not.toBeNull();
		// given the detector just fired, a fourth similar turn stays latched
		expect(recordTurnText(state, SESSION_STATUS_VARIANTS[3])).toBeNull();
		// when a dissimilar turn arrives, the streak resets and unlatches
		expect(
			recordTurnText(
				state,
				"The Windows timeout occurs inside the integration binary: only the two pure buffer tests finish; every live lifecycle test stalls.",
			),
		).toBeNull();
		expect(state.latched).toBe(false);
		expect(state.streak).toBe(0);
	});

	it("does not let an old dissimilar turn break a current streak (window is consecutive)", () => {
		const state = createRepetitiveTurnsState();
		recordTurnText(
			state,
			"Completely unrelated planning note about refactoring the parser into smaller units with tests.",
		);
		expect(recordTurnText(state, SESSION_STATUS_VARIANTS[0])).toBeNull();
		expect(recordTurnText(state, SESSION_STATUS_VARIANTS[1])).toBeNull();
		expect(recordTurnText(state, SESSION_STATUS_VARIANTS[2])).not.toBeNull();
	});
});
