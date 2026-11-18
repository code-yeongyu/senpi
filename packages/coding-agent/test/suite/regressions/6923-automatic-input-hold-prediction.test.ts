import { afterEach, describe, expect, it } from "vitest";
import { automaticInputWouldBeHeld, holdAutomaticInput } from "../../../src/modes/rpc/automatic-input-gate.ts";
import { createIdentityHarness } from "../rpc-client-identity-harness.ts";

// senpi#6957: which hold states keep automatic connection input as a notice. The leaf guard's prediction
// (`automaticInputWouldBeHeld`) and the hold itself (`holdAutomaticInput`) are each pinned to the expected outcome.
describe("automatic input hold", () => {
	const fixtures: Awaited<ReturnType<typeof createIdentityHarness>>[] = [];
	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) await fixture.cleanup();
	});

	const created = async () => {
		const fixture = await createIdentityHarness();
		fixtures.push(fixture);
		return fixture.session;
	};

	it("does not hold on a free session or on an unattended hold alone", async () => {
		const session = await created();
		expect(automaticInputWouldBeHeld(session, false)).toBe(false);
		expect(holdAutomaticInput(session, { type: "prompt", message: "automatic" }, false)).toBe(false);

		session.holdAutomaticTurns();
		expect(automaticInputWouldBeHeld(session, false)).toBe(false);
		expect(holdAutomaticInput(session, { type: "prompt", message: "automatic" }, false)).toBe(false);
	});

	it("holds while a parent's run hold is live, except for an interactive user or a steer naming its turn", async () => {
		const session = await created();
		await session.pauseForRun({ parentSessionId: "parent", parentPauseSeq: 1, runRef: { kind: "task", id: "r1" } });

		expect(automaticInputWouldBeHeld(session, false)).toBe(true);
		expect(automaticInputWouldBeHeld(session, true)).toBe(false);
		expect(holdAutomaticInput(session, { type: "steer", message: "turn-bound", expectedTurnId: "t1" }, false)).toBe(
			false,
		);
		expect(holdAutomaticInput(session, { type: "prompt", message: "automatic" }, true)).toBe(false);
		expect(holdAutomaticInput(session, { type: "prompt", message: "automatic" }, false)).toBe(true);
	});
});
