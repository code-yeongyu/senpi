import { describe, expect, it } from "vitest";
import { attempt, createLoopGuardHarness } from "../loop-guard-test-harness.ts";

/**
 * Pins for the consecutive-repeat ladder's exact timing, added with senpi#3629:
 * notice at the 3rd consecutive call, a second at the 6th, blocks from the 7th,
 * and the hard stop at the 9th — the values main ships today. The interleaved
 * (non-consecutive) blind spot is tracked in the follow-up issue #4156; these
 * pins guard that the consecutive stop keeps this timing while the windowed
 * detector is designed there.
 */

const EVAL_ARGS = { code: "reverseEngineer(input)" } as const;

interface BlockResult {
	block: boolean;
}

function isBlockResult(value: unknown): value is BlockResult {
	return (
		typeof value === "object" && value !== null && "block" in value && (value as { block: unknown }).block === true
	);
}

describe("issue 3629: consecutive ladder pins", () => {
	it("blocks from the 7th identical call and hard-stops at the 9th", async () => {
		const harness = createLoopGuardHarness();
		let abortRound = 0;
		for (let round = 1; round <= 12; round++) {
			const result = await attempt(harness, `eval-${round}`, "eval", { ...EVAL_ARGS });
			const blocked = isBlockResult(result);
			if (round < 7) expect(blocked).toBe(false);
			if (round >= 7) expect(blocked).toBe(true);
			if (abortRound === 0 && harness.actions.includes("abort:system")) abortRound = round;
		}
		expect(abortRound).toBe(9);
	});

	it("notifies at the 3rd call of each fresh run and re-arms the block from scratch after a break", async () => {
		const harness = createLoopGuardHarness();
		const noticeCount = (): number =>
			harness.customMessages.filter((message) => message.customType === "loop-guard:notice").length;
		const noticesPerRead: number[] = [];
		const blockedAt: number[] = [];
		let abortRound = 0;
		const read = async (round: number): Promise<void> => {
			const result = await attempt(harness, `read-${round}`, "read", { path: "a.ts" });
			noticesPerRead.push(noticeCount());
			if (isBlockResult(result)) blockedAt.push(round);
			if (abortRound === 0 && harness.actions.includes("abort:system")) abortRound = round;
		};
		for (let round = 1; round <= 4; round++) await read(round);
		await attempt(harness, "edit-1", "edit", { path: "b.ts", old: "x", new: "y" });
		for (let round = 5; round <= 14; round++) await read(round);
		// First run: the notice lands on its 3rd call. After the edit resets the run,
		// the next notice lands on the 3rd call after the break — read 7, not read 6.
		expect(noticesPerRead.slice(0, 7)).toEqual([0, 0, 1, 1, 1, 1, 2]);
		// The fresh episode needs its own second notice (read 10) before arming, so the
		// block starts at read 11 and the hard stop at read 13 — not at reads 8 and 10,
		// which is where a carry-over episode would put them.
		expect(blockedAt[0]).toBe(11);
		expect(abortRound).toBe(13);
	});
});
