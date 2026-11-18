import { afterEach, describe, expect, it } from "vitest";
import { automaticInputWouldBeHeld, holdAutomaticInput } from "../../../src/modes/rpc/automatic-input-gate.ts";
import { createIdentityHarness } from "../rpc-client-identity-harness.ts";

// senpi#6923 review L: the leaf guard's "would this prompt be held" check and the hold that actually keeps automatic
// input as a notice share one predicate, so the guard can never answer differently from the hold it predicts.
describe("automatic input hold prediction", () => {
	const fixtures: Awaited<ReturnType<typeof createIdentityHarness>>[] = [];
	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) await fixture.cleanup();
	});

	const predictionMatchesHold = async (fixture: Awaited<ReturnType<typeof createIdentityHarness>>) => {
		const predicted = automaticInputWouldBeHeld(fixture.session, false);
		const held = holdAutomaticInput(fixture.session, { type: "prompt", message: "automatic" }, false);
		expect(predicted).toBe(held);
		return held;
	};

	it("predicts no hold on a free session and on an unattended hold alone", async () => {
		const fixture = await createIdentityHarness();
		fixtures.push(fixture);
		expect(await predictionMatchesHold(fixture)).toBe(false);

		fixture.session.holdAutomaticTurns();
		expect(await predictionMatchesHold(fixture)).toBe(false);
	});

	it("predicts the hold while a parent's run hold is live, and never for an interactive user", async () => {
		const fixture = await createIdentityHarness();
		fixtures.push(fixture);
		await fixture.session.pauseForRun({
			parentSessionId: "parent",
			parentPauseSeq: 1,
			runRef: { kind: "task", id: "r1" },
		});

		expect(automaticInputWouldBeHeld(fixture.session, true)).toBe(false);
		expect(await predictionMatchesHold(fixture)).toBe(true);
	});
});
