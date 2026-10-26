import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import type { Harness } from "../harness.ts";
import { createBoundLifecycleHarness as createHarness, runToAgentIdle } from "../lifecycle-test-harness.ts";

// senpi#3980: a person's turn writes one running record when its epoch opens and one terminal record when it seals.
const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});

function lifecycleRecords(h: Harness) {
	return h.session.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "session-lifecycle")
		.map((entry) => {
			const data = (entry as { data: { state: string; epoch: number; runActive?: boolean } }).data;
			return { state: data.state, epoch: data.epoch, runActive: data.runActive === true };
		});
}

it.each([1, 2])("writes exactly one running and one done record for person turn %i", async (turn) => {
	// Given a session that has already finished (turn - 1) person turns.
	const h = await createHarness();
	harnesses.push(h);
	h.setResponses(Array.from({ length: turn }, (_, index) => fauxAssistantMessage(`Reply ${index + 1}.`)));
	for (let index = 1; index < turn; index++) await runToAgentIdle(h, () => h.session.prompt(`Request ${index}`));
	const before = lifecycleRecords(h).length;

	// When the person sends one more prompt and the reply ends.
	await runToAgentIdle(h, () => h.session.prompt(`Request ${turn}`));

	// Then that turn wrote exactly the epoch's opening and its seal.
	const epoch = h.session.lifecycle.epoch;
	expect(lifecycleRecords(h).slice(before)).toEqual([
		{ state: "running", epoch, runActive: true },
		{ state: "done", epoch, runActive: false },
	]);
});
