import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

// senpi#3459: a change to a queued input can name the revision it was based on; a stale one is refused atomically.

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

describe("queued input expected revision (senpi#3459)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("starts every queued input at revision 1 and bumps it on each edit", async () => {
		const { harness, release, done } = await heldTurn();
		harnesses.push(harness);
		await harness.session.steer("draft");
		const [input] = harness.session.getQueuedInputs();
		expect(input?.revision).toBe(1);

		expect(harness.session.editQueuedInput(input!.queuedId, "second", { expectedRevision: 1 })).toBe("edited");
		expect(harness.session.getQueuedInputs()[0]?.revision).toBe(2);
		expect(harness.session.editQueuedInput(input!.queuedId, "third")).toBe("edited");
		expect(harness.session.getQueuedInputs()[0]?.revision).toBe(3);
		release();
		await done;
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["start", "third"]);
	});

	it("refuses the second of two edits based on the same revision and keeps the first", async () => {
		const { harness, release, done } = await heldTurn();
		harnesses.push(harness);
		await harness.session.steer("draft");
		const [seen] = harness.session.getQueuedInputs();

		expect(harness.session.editQueuedInput(seen!.queuedId, "client B", { expectedRevision: seen!.revision })).toBe(
			"edited",
		);
		expect(harness.session.editQueuedInput(seen!.queuedId, "client A", { expectedRevision: seen!.revision })).toBe(
			"conflict",
		);
		expect(harness.session.getQueuedInputs()).toMatchObject([
			{ queuedId: seen!.queuedId, text: "client B", revision: 2 },
		]);
		expect(harness.session.getSteeringMessages()).toEqual(["client B"]);
		release();
		await done;
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["start", "client B"]);
	});

	it("refuses a dequeue based on a revision another edit replaced, then removes it at the current revision", async () => {
		const { harness, release, done } = await heldTurn();
		harnesses.push(harness);
		await harness.session.followUp("draft");
		const [seen] = harness.session.getQueuedInputs();
		expect(harness.session.editQueuedInput(seen!.queuedId, "edited by B", { expectedRevision: 1 })).toBe("edited");

		expect(harness.session.dequeueQueuedInput(seen!.queuedId, { expectedRevision: 1 })).toBe("conflict");
		expect(harness.session.getFollowUpMessages()).toEqual(["edited by B"]);
		expect(harness.session.dequeueQueuedInput(seen!.queuedId, { expectedRevision: 2 })).toBe("removed");
		release();
		await done;
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["start"]);
	});

	it("answers not_found or already_delivered rather than conflict once the input is gone", async () => {
		const { harness, release, done } = await heldTurn();
		harnesses.push(harness);
		await harness.session.steer("removed first");
		await harness.session.steer("delivered");
		const [removed, delivered] = harness.session.getQueuedInputs();
		expect(harness.session.dequeueQueuedInput(removed!.queuedId)).toBe("removed");
		expect(harness.session.editQueuedInput(removed!.queuedId, "late", { expectedRevision: 7 })).toBe("not_found");
		release();
		await done;
		await harness.session.waitForIdle();
		expect(harness.session.editQueuedInput(delivered!.queuedId, "late", { expectedRevision: 7 })).toBe(
			"already_delivered",
		);
		expect(harness.session.dequeueQueuedInput(delivered!.queuedId, { expectedRevision: 7 })).toBe(
			"already_delivered",
		);
	});

	it("refuses a stale revision on an input held back after a compaction, and edits it at the current one", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		// The post-compaction window: a restored input waits in the deferred lists until the next prompt starts.
		const internals = harness.session as unknown as {
			_promptStartPending: boolean;
			_skipNextPostCompactionAssistantCheck: boolean;
		};
		internals._promptStartPending = true;
		internals._skipNextPostCompactionAssistantCheck = true;
		await harness.session.restoreQueuedInput({ text: "deferred draft", mode: "followUp", enqueueOrder: 1 });
		const [seen] = harness.session.getQueuedInputs();
		expect(harness.session.editQueuedInput(seen!.queuedId, "edited once", { expectedRevision: 1 })).toBe("edited");

		expect(harness.session.editQueuedInput(seen!.queuedId, "stale edit", { expectedRevision: 1 })).toBe("conflict");
		expect(harness.session.dequeueQueuedInput(seen!.queuedId, { expectedRevision: 1 })).toBe("conflict");
		expect(harness.session.getQueuedInputs()).toMatchObject([{ text: "edited once", revision: 2 }]);
		expect(harness.session.getFollowUpMessages()).toEqual(["edited once"]);
		expect(harness.session.editQueuedInput(seen!.queuedId, "edited twice", { expectedRevision: 2 })).toBe("edited");
		expect(harness.session.getQueuedInputs()).toMatchObject([{ text: "edited twice", revision: 3 }]);
	});
});
