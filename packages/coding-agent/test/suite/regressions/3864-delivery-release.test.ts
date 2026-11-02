import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import type { Harness } from "../harness.ts";
import { createBoundLifecycleHarness } from "../lifecycle-test-harness.ts";

// senpi#3864 review (#3964): a delivery that leaves the queue undelivered, or that only a person will
// release, must not hold the session waiting on background work, and must not come back after a restart.
const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

const wake = { customType: "wake-x", content: "Background result.", display: false };

function custodyStates(h: Harness): string[] {
	return h.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom" &&
			entry.customType === "work-custody" &&
			typeof entry.data === "object" &&
			entry.data !== null &&
			"state" in entry.data &&
			typeof entry.data.state === "string"
				? [entry.data.state]
				: [],
		);
}

async function heldTurn(): Promise<{ h: Harness; release: () => void; done: Promise<void> }> {
	const gate = Promise.withResolvers<void>();
	const wait: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			await gate.promise;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
	const h = await createBoundLifecycleHarness({ tools: [wait], persistSession: true });
	harnesses.push(h);
	h.setResponses([
		fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("after the tool"),
		fauxAssistantMessage("after the follow-up"),
	]);
	const started = new Promise<void>((resolve) => {
		const unsubscribe = h.session.subscribe((event) => {
			if (event.type !== "tool_execution_start") return;
			unsubscribe();
			resolve();
		});
	});
	const done = h.session.prompt("start");
	await started;
	return { h, release: gate.resolve, done };
}

it("cancels a cleared follow-up's delivery ticket", async () => {
	// Given a background result queued as a follow-up while the turn runs.
	const { h, release, done } = await heldTurn();
	await h.session.sendCustomMessage(wake, { deliverAs: "followUp" });
	expect(h.session.workObligations.activeCount).toBe(1);

	// When a person clears the queue and the turn ends.
	h.session.clearQueue();
	release();
	await done;

	// Then no obligation is left, and the cleared message has no payload a restart could send again.
	expect(h.session.workObligations.activeCount).toBe(0);
	expect(h.session.lifecycle.state).toBe("done");
	expect(custodyStates(h)).toContain("cancelled");
	expect(h.session.workObligations.active.filter((record) => record.payload !== undefined)).toEqual([]);
});

it("releases a follow-up that an abort left queued for the person", async () => {
	// Given a background result queued as a follow-up while the turn runs.
	const { h, release, done } = await heldTurn();
	await h.session.sendCustomMessage(wake, { deliverAs: "followUp" });

	// When the person aborts the turn.
	const aborting = h.session.abort();
	release();
	await aborting;
	await done;
	await h.session.waitForIdle();

	// Then the session does not wait on background work nobody will drain.
	expect(h.session.workObligations.activeCount).toBe(0);
	expect(h.session.lifecycle.waitingOn?.background ?? []).toEqual([]);
	expect(h.session.lifecycle.state).not.toBe("waiting_background");
});

it.each(["clear", "abort"] as const)(
	"releases an engine delivery handed back after a restart on %s",
	async (release) => {
		// Given an engine delivery restored from custody and re-sent with its own ticket, as recovery does.
		const { h, release: finish, done } = await heldTurn();
		const ticket = h.session.workObligations.open("delivery:wake-x:restored", "background").ticket();
		await h.session.sendCustomMessage(wake, { deliverAs: "followUp", ticket });

		// When the person clears the queue or aborts the turn.
		if (release === "clear") {
			h.session.clearQueue();
			finish();
			await done;
		} else {
			const aborting = h.session.abort();
			finish();
			await aborting;
			await done;
			await h.session.waitForIdle();
		}

		// Then the engine still owns it by its durable key, so nothing is left waiting.
		expect(h.session.workObligations.activeCount).toBe(0);
		expect(h.session.lifecycle.state).not.toBe("waiting_background");
	},
);

it("does not count a next-turn message sent while idle as background work", async () => {
	// Given a finished turn.
	const h = await createBoundLifecycleHarness({ persistSession: true });
	harnesses.push(h);
	h.setResponses([fauxAssistantMessage("done")]);
	await h.session.prompt("start");
	await h.session.waitForIdle();
	expect(h.session.lifecycle.state).toBe("done");

	// When an extension leaves a note for the person's next turn.
	await h.session.sendCustomMessage(wake, { triggerTurn: false, deliverAs: "nextTurn" });

	// Then the session stays done: only a person can release that note.
	expect(h.session.workObligations.activeCount).toBe(0);
	expect(h.session.lifecycle.state).toBe("done");
});
