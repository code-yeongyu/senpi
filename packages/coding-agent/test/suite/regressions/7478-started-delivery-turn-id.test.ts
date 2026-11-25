import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

// senpi#7478 (omo#15013): an external message admitted to an idle session starts a turn, but the reply named the turn
// BEFORE it: the start was not awaited, so the epoch was read before the started run raised it. An agent that steered or
// interrupted with the turn id its own delivery was answered was refused with turn_conflict or acted on no turn.

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function harness(): Promise<Harness> {
	const created = await createHarness({ persistSession: true });
	harnesses.push(created);
	return created;
}

function nextEvent(target: Harness, type: string): Promise<void> {
	return new Promise((resolve) => {
		const unsubscribe = target.session.subscribe((event) => {
			if (event.type !== type) return;
			unsubscribe();
			resolve();
		});
	});
}

function epochAtNextStart(target: Harness): Promise<number> {
	return new Promise((resolve) => {
		const unsubscribe = target.session.subscribe((event) => {
			if (event.type !== "agent_start") return;
			unsubscribe();
			resolve(target.session.externalAdmission.turnEpoch);
		});
	});
}

describe("an external message that starts a turn is answered with that turn (senpi#7478)", () => {
	it("names the turn the admitted message runs in, not the one before it", async () => {
		const target = await harness();
		target.setResponses([fauxAssistantMessage("ack")]);
		const admission = target.session.externalAdmission;
		const runEpoch = epochAtNextStart(target);
		const idle = nextEvent(target, "agent_idle");

		const answer = admission.admit({ delivery_id: "d-1", text: "hello", deliverAs: "followUp" });

		expect(answer.kind).toBe("started");
		expect(answer.turn_epoch).toBe(await runEpoch);
		await idle;
	});

	it("accepts a steer that names the answered turn while that start is still pending", async () => {
		const target = await harness();
		target.setResponses([fauxAssistantMessage("ack")]);
		const admission = target.session.externalAdmission;
		const idle = nextEvent(target, "agent_idle");

		const started = admission.admit({ delivery_id: "d-1", text: "hello", deliverAs: "followUp" });
		const steer = admission.admit({
			delivery_id: "s-1",
			text: "and this",
			deliverAs: "steer",
			expected_turn_id: started.turn_epoch,
		});

		expect(steer).toEqual({ kind: "steered", turn_epoch: started.turn_epoch });
		await idle;
		expect(admission.list()).toEqual({ pending: [], emitted: ["d-1", "s-1"] });
	});

	it("answers a delivery that joins the pending start with the same turn", async () => {
		const target = await harness();
		target.setResponses([fauxAssistantMessage("ack")]);
		const admission = target.session.externalAdmission;
		const runEpoch = epochAtNextStart(target);
		const idle = nextEvent(target, "agent_idle");

		const started = admission.admit({ delivery_id: "d-1", text: "hello", deliverAs: "followUp" });
		const joined = admission.admit({ delivery_id: "d-2", text: "me too", deliverAs: "followUp" });

		expect(joined).toEqual({ kind: "steered", turn_epoch: started.turn_epoch });
		expect(joined.turn_epoch).toBe(await runEpoch);
		await idle;
	});
});
