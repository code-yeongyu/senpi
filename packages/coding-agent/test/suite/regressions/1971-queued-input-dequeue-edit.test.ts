import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";
import { createIdentityHarness } from "../rpc-client-identity-harness.ts";

// senpi#1971: every queued input has a queuedId; dequeue/edit act on the visible lists and the native queue alike.

async function heldTurn(): Promise<{ harness: Harness; release: () => void; done: Promise<void> }> {
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
	const harness = await createHarness({ tools: [wait] });
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("after steering"),
		fauxAssistantMessage("after follow-up"),
	]);
	const started = new Promise<void>((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== "tool_execution_start") return;
			unsubscribe();
			resolve();
		});
	});
	const done = harness.session.prompt("start");
	await started;
	return { harness, release: gate.resolve, done };
}

describe("queued input identity, dequeue and edit (senpi#1971)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("removes only the dequeued steer from both queues and delivers the other", async () => {
		const { harness, release, done } = await heldTurn();
		harnesses.push(harness);
		await harness.session.steer("drop me");
		await harness.session.steer("keep me");
		const [first, second] = harness.session.getQueuedInputs();
		expect(first?.queuedId).toMatch(/^q_\d+$/);
		expect(second?.queuedId).not.toBe(first?.queuedId);

		expect(harness.session.dequeueQueuedInput(first!.queuedId)).toBe("removed");
		expect(harness.session.getSteeringMessages()).toEqual(["keep me"]);
		expect(harness.session.getQueuedInputs().map((input) => input.queuedId)).toEqual([second!.queuedId]);
		release();
		await done;
		await harness.session.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["start", "keep me"]);
		expect(harness.session.dequeueQueuedInput(second!.queuedId)).toBe("already_delivered");
		expect(harness.session.dequeueQueuedInput("q_999")).toBe("not_found");
	});

	it("delivers the edited text in the input's original place", async () => {
		const { harness, release, done } = await heldTurn();
		harnesses.push(harness);
		await harness.session.steer("first steer");
		await harness.session.followUp("typo follw-up");
		const followUp = harness.session.getQueuedInputs().find((input) => input.mode === "followUp");

		expect(harness.session.editQueuedInput(followUp!.queuedId, "fixed follow-up")).toBe("edited");
		expect(harness.session.getFollowUpMessages()).toEqual(["fixed follow-up"]);
		release();
		await done;
		await harness.session.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["start", "first steer", "fixed follow-up"]);
	});

	it("tells two queued inputs with the same text apart", async () => {
		const { harness, release, done } = await heldTurn();
		harnesses.push(harness);
		await harness.session.steer("same");
		await harness.session.steer("same");
		const [, second] = harness.session.getQueuedInputs();

		expect(harness.session.editQueuedInput(second!.queuedId, "changed")).toBe("edited");
		expect(harness.session.getSteeringMessages()).toEqual(["same", "changed"]);
		release();
		await done;
		await harness.session.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["start", "same", "changed"]);
	});
});

describe("an edited durable queued input across a reopen (senpi#1971)", () => {
	const fixtures: Awaited<ReturnType<typeof createIdentityHarness>>[] = [];
	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) await fixture.cleanup();
	});

	it("restores the edited text, not the text first sent", async () => {
		const fixture = await createIdentityHarness();
		fixtures.push(fixture);
		fixture.harness.setResponses([fauxAssistantMessage("one")]);
		const rpc = fixture.bind();
		await rpc.send({ type: "follow_up", message: "use production", clientMessageId: "f1" });
		const before = await rpc.send({ type: "get_state" });
		const queuedId = (before.data as { ordered?: { queuedId: string }[] } | undefined)?.ordered?.[0]?.queuedId;

		const edited = await rpc.send({ type: "edit_queued_message", queuedId, text: "use staging" });
		const reopened = await fixture.reopen();
		const after = await reopened.send({ type: "get_state" });

		expect(edited).toMatchObject({ data: { status: "edited" } });
		const ordered = (after.data as { ordered?: { text: string }[] } | undefined)?.ordered ?? [];
		expect(ordered.map((input) => input.text)).toEqual(["use staging"]);
	});
});
