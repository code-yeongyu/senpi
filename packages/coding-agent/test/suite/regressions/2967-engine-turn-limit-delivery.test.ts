import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import { createHarness, type Harness } from "../harness.ts";

async function drain(harness: Harness): Promise<void> {
	for (let pass = 0; pass < 20; pass++) {
		await harness.session.waitForIdle();
		await Promise.resolve();
	}
}

describe("senpi#2967 a cross-session delivery refused by the engine-turn limit", () => {
	let harness: Harness;

	afterEach(() => {
		harness.cleanup();
	});

	it("is recorded and settled instead of staying pending", async () => {
		// given a session whose automatic-turn budget after the user's message is spent
		harness = await createHarness({ settings: { engineTurns: { maxPerUserInput: 1 } } });
		harness.setResponses([
			fauxAssistantMessage([fauxText("user reply")]),
			fauxAssistantMessage([fauxText("d-1 reply")]),
		]);
		await harness.session.prompt("hello");
		harness.session.externalAdmission.admit({ delivery_id: "d-1", text: "DELIVERY d-1", deliverAs: "followUp" });
		await drain(harness);

		// when another delivery arrives with the budget spent
		const result = harness.session.externalAdmission.admit({
			delivery_id: "d-2",
			text: "DELIVERY d-2",
			deliverAs: "followUp",
		});
		await drain(harness);

		// then it started no turn, but it is in the session and no longer pending
		expect(result.kind).toBe("started");
		expect(harness.faux.getCallLog()).toHaveLength(2);
		expect(harness.session.externalAdmission.list()).toEqual({ pending: [], emitted: ["d-1", "d-2"] });
	});
});
