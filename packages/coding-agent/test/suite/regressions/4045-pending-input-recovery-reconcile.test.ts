import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { PendingInputAppendUncertainError } from "../../../src/core/pending-input-journal.ts";
import { SessionPendingInputs } from "../../../src/core/pending-input-session.ts";
import { PendingInputStore, PendingInputStoreUnavailableError } from "../../../src/core/pending-input-store.ts";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";
import { UncertainJournal } from "./4045-pending-input-recovery-support.ts";

// senpi#4045 review: a failed claim holds its drained copy until the next claim, and recovery reconciles every owner.
const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

async function sessionOver(journal: UncertainJournal) {
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
	const session = harness.session as unknown as { _pendingInputs: SessionPendingInputs; _mintQueuedId(): string };
	session._pendingInputs = new SessionPendingInputs({
		sessionManager: harness.sessionManager,
		journal,
		nextQueuedId: () => session._mintQueuedId(),
	});
	harness.agent.queuedInputPort = session._pendingInputs.queuedInputPort();
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

// The follow-up claim after the first turn fails: its reservation's sync fails and the record never reached the file.
async function failedFollowUpClaim() {
	const journal = new UncertainJournal();
	journal.failures = 0;
	const { harness, release, toolStarted } = await sessionOver(journal);
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("first"),
	]);
	const run = harness.session.prompt("start");
	await toolStarted;
	await harness.session.followUp("draft", undefined, { clientMessageId: "c-1" });
	const queuedId = harness.session.getQueuedInputs()[0]?.queuedId ?? "";
	journal.failPhase = "sending";
	journal.landed = false;
	journal.failures = 1;
	release();
	await run;
	return { harness, journal, queuedId };
}

describe("senpi#4045 review: changes between a failed claim and the next claim", () => {
	it("applies an edit to the held copy, so the next turn sends the edited text", async () => {
		const { harness, journal, queuedId } = await failedFollowUpClaim();
		harness.setResponses([fauxAssistantMessage("next"), fauxAssistantMessage("handled")]);

		await expect(harness.session.changeQueuedInput(queuedId, "final")).resolves.toBe("edited");
		expect(harness.session.getQueuedInputs().map((input) => input.text)).toEqual(["final"]);
		await harness.session.prompt("next prompt");

		expect(getUserTexts(harness)).toEqual(["start", "next prompt", "final"]);
		expect((await harness.session.getPendingInputs(["c-1"])).outcomes).toMatchObject([
			{ status: "admitted", projection: { state: "delivered", text: "final" } },
		]);
		expect(journal.records.map((record) => record.cursor)).toEqual(
			journal.records.map((_record, index) => index + 1),
		);
	});

	it("applies a removal to the held copy, so the next turn sends nothing for it", async () => {
		const { harness, queuedId } = await failedFollowUpClaim();
		harness.setResponses([fauxAssistantMessage("next")]);

		await expect(harness.session.changeQueuedInput(queuedId, undefined)).resolves.toBe("removed");
		expect(harness.session.getQueuedInputs()).toEqual([]);
		await harness.session.prompt("next prompt");

		expect(getUserTexts(harness)).toEqual(["start", "next prompt"]);
		expect((await harness.session.getPendingInputs(["c-1"])).outcomes).toMatchObject([
			{ status: "admitted", projection: { state: "removed" } },
		]);
	});
});

describe("senpi#4045 review: recovery callbacks", () => {
	it("reports a throwing callback as itself and still releases the recovered admission", async () => {
		const journal = new UncertainJournal();
		journal.failures = 0;
		const released: string[][] = [];
		let ids = 0;
		const store = await PendingInputStore.open({
			journal,
			lifetimeId: "live",
			nextQueuedId: () => `q_${++ids}`,
			dispatch: () => {
				throw new Error("dispatch failed");
			},
			onRecovered: (inputs) => released.push(inputs.map((input) => input.clientMessageId)),
		});
		await store.submit({
			clientMessageId: "c-1",
			fingerprint: "c-1",
			text: "keep",
			attachments: [],
			requestedMode: "followUp",
		});
		journal.failures = 1;
		const token = {
			clientMessageId: "c-1",
			lifetimeId: "live",
			ownerId: "owner",
			writerGeneration: 1,
			attemptId: "a",
		};
		await expect(store.apply("c-1", { type: "reserve", token })).rejects.toBeInstanceOf(
			PendingInputAppendUncertainError,
		);

		const failure = await store.transaction(async () => "ran").catch((error: unknown) => error);

		expect(failure).not.toBeInstanceOf(PendingInputStoreUnavailableError);
		expect(String(failure)).toBe("Error: dispatch failed");
		expect(released).toEqual([["c-1"]]);
		await expect(store.transaction(async () => "ran")).resolves.toBe("ran");
	});
});
