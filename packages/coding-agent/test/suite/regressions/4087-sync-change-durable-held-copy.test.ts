import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { PENDING_INPUT_TRANSITION, type PendingInputJournalRecord } from "../../../src/core/pending-input-store.ts";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

// senpi#4087: the synchronous dequeue/edit path must not change an input the
// store owns. Before the fix it removed/edited the queue copy without writing
// any record, so the record stayed `queued` and a reopen queued the input
// again. The store-backed `changeQueuedInput` is the only path that may
// change a durable copy; the sync methods answer `conflict` and leave it
// untouched. Inputs without a record keep the legacy sync answers.

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

async function runWithHeldTool() {
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const waitTool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			await held;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
	const harness = await createHarness({ tools: [waitTool] });
	harnesses.push(harness);
	const toolStarted = new Promise<void>((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				unsubscribe();
				resolve();
			}
		});
	});
	return { harness, release, toolStarted };
}

function phases(harness: Harness, clientMessageId: string): string[] {
	return harness.session.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === PENDING_INPUT_TRANSITION ? [entry.data] : [],
		)
		.filter((data): data is PendingInputJournalRecord => (data as PendingInputJournalRecord).input !== undefined)
		.filter((record) => record.input.clientMessageId === clientMessageId)
		.map((record) => record.input.phase);
}

describe("sync queued-input change of a durable input (senpi#4087)", () => {
	it("refuses a sync dequeue of a still-queued durable input and delivers it unchanged", async () => {
		const { harness, release, toolStarted } = await runWithHeldTool();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("handled"),
		]);
		const run = harness.session.prompt("start");
		await toolStarted;

		await harness.session.followUp("keep me", undefined, { clientMessageId: "c-1" });
		const queuedId = harness.session.getQueuedInputs()[0]?.queuedId ?? "";

		expect(harness.session.dequeueQueuedInput(queuedId)).toBe("conflict");
		expect(harness.session.getQueuedInputs().map((input) => input.text)).toEqual(["keep me"]);
		expect(phases(harness, "c-1")).toEqual(["queued"]);

		release();
		await run;

		expect(getUserTexts(harness)).toEqual(["start", "keep me"]);
		expect(phases(harness, "c-1")).toEqual(["queued", "sending", "delivered"]);
	});

	it("refuses a sync edit of a still-queued durable input and keeps its text and revision", async () => {
		const { harness, release, toolStarted } = await runWithHeldTool();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("handled"),
		]);
		const run = harness.session.prompt("start");
		await toolStarted;

		await harness.session.followUp("draft", undefined, { clientMessageId: "c-1" });
		const queuedId = harness.session.getQueuedInputs()[0]?.queuedId ?? "";

		expect(harness.session.editQueuedInput(queuedId, "changed")).toBe("conflict");
		expect(harness.session.getQueuedInputs()).toMatchObject([{ text: "draft", revision: 1 }]);
		expect(phases(harness, "c-1")).toEqual(["queued"]);

		release();
		await run;

		expect(getUserTexts(harness)).toEqual(["start", "draft"]);
	});

	it("still removes an input without a store record through the sync path", async () => {
		const { harness, release, toolStarted } = await runWithHeldTool();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("handled"),
		]);
		const run = harness.session.prompt("start");
		await toolStarted;

		await harness.session.followUp("drop me");
		const queuedId = harness.session.getQueuedInputs()[0]?.queuedId ?? "";

		expect(harness.session.dequeueQueuedInput(queuedId)).toBe("removed");
		expect(harness.session.getQueuedInputs()).toEqual([]);

		release();
		await run;

		expect(getUserTexts(harness)).toEqual(["start"]);
	});
});
