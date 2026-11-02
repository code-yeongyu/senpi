/**
 * senpi#3229: external admission honours the RPC `whenIdle` semantics, so a terminal control endpoint's
 * `steer`/`follow_up` mean what they mean on a host. `start` (the default, today's drains) starts a
 * turn on an idle session; `queue` holds the input for the next turn, in the mode it was sent as.
 */
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function idleHarness(): Promise<{ harness: Harness; starts: () => number }> {
	const harness = await createHarness({ settings: { retry: { enabled: false } } });
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("ran")]);
	let starts = 0;
	harness.session.subscribe((event) => {
		if (event.type === "agent_start") starts += 1;
	});
	return { harness, starts: () => starts };
}

describe("external admission whenIdle (senpi#3229)", () => {
	it.each([
		{ deliverAs: "steer", queue: "steering" },
		{ deliverAs: "followUp", queue: "followUp" },
	] as const)("queues an idle $deliverAs with whenIdle queue in its own queue", async ({ deliverAs, queue }) => {
		const { harness, starts } = await idleHarness();

		const result = harness.session.externalAdmission.admit({
			delivery_id: "d-queue",
			text: "for the next turn",
			deliverAs,
			whenIdle: "queue",
		});
		await harness.session.waitForIdle();

		expect(result.kind).toBe("queued");
		expect(starts()).toBe(0);
		const agent = harness.session.agent;
		expect(agent.peekQueuedMessages()).toHaveLength(1);
		// It sits in the queue of its own mode: clearing the other one leaves it, clearing its own empties it.
		if (queue === "steering") agent.clearFollowUpQueue();
		else agent.clearSteeringQueue();
		expect(agent.hasQueuedMessages()).toBe(true);
		if (queue === "steering") agent.clearSteeringQueue();
		else agent.clearFollowUpQueue();
		expect(agent.hasQueuedMessages()).toBe(false);
		expect(harness.session.externalAdmission.list().pending).toEqual(["d-queue"]);
	});

	it("still starts a turn on an idle session by default", async () => {
		const { harness, starts } = await idleHarness();

		const result = harness.session.externalAdmission.admit({
			delivery_id: "d-start",
			text: "now",
			deliverAs: "steer",
		});
		await harness.session.waitForIdle();
		await harness.session.waitForSettledSessionWork();

		expect(result.kind).toBe("started");
		expect(starts()).toBe(1);
	});
});
