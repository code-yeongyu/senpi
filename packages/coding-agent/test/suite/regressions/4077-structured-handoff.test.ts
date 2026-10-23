import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { findHandoffBlocks } from "../../../src/core/handoff-block.ts";
import { toJsonEvent } from "../../../src/modes/json-event.ts";
import { subscribeSessionRecords } from "../../../src/modes/rpc/session-record-stream.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#4077: the handoff block is a separable, typed part of the reply for every reader, derived from the
// text so the transcript and old sessions are unchanged.
const BLOCK =
	"Ask: fix the login redirect - wanted: users land on the dashboard. For you: the redirect reads the saved path; 12 tests pass. Now: Report the fix. Next: Open the PR.";
const GPT_BLOCK = "Redirect fixed for every user. You need: 3/3 done, no blockers. Now: Report the fix. Next: none.";
const ANSWER = "The parser reads the header, then checks its length.";

describe("regression #4077: the handoff block is a structured part of the reply", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function replyWith(text: string): Promise<{ harness: Harness; records: object[] }> {
		const harness = await createHarness();
		harnesses.push(harness);
		const records: object[] = [];
		const unsubscribe = subscribeSessionRecords(harness.session, (record) => records.push(record));
		harness.setResponses([fauxAssistantMessage(text)]);
		await harness.session.prompt("respond");
		unsubscribe();
		return { harness, records };
	}

	it("splits a Claude block into typed slots and keeps the prose around it out", () => {
		const message = { role: "assistant", content: [{ type: "text", text: `Done.\n\n${BLOCK}\n\nDetail after.` }] };
		expect(findHandoffBlocks(message)).toEqual([
			{
				shape: "claude",
				block: BLOCK,
				ask: "fix the login redirect",
				wanted: "users land on the dashboard.",
				forYou: "the redirect reads the saved path; 12 tests pass.",
				outcome: undefined,
				youNeed: undefined,
				answer: "the redirect reads the saved path; 12 tests pass.",
				now: "Report the fix.",
				next: "Open the PR.",
				contentIndex: 0,
			},
		]);
	});

	it("splits a GPT block into its outcome and You need slots", () => {
		const [block] = findHandoffBlocks({ role: "assistant", content: [{ type: "text", text: GPT_BLOCK }] });
		expect(block).toMatchObject({
			shape: "gpt",
			outcome: "Redirect fixed for every user.",
			youNeed: "3/3 done, no blockers.",
		});
	});

	it("ignores model-only text parts and non-assistant messages", () => {
		expect(
			findHandoffBlocks({ role: "assistant", content: [{ type: "text", text: BLOCK, audience: "model" }] }),
		).toEqual([]);
		expect(findHandoffBlocks({ role: "user", content: [{ type: "text", text: BLOCK }] })).toEqual([]);
	});

	it("JSON and RPC message_end records carry the parsed handoffs; the transcript keeps the full text", async () => {
		const { harness, records } = await replyWith(`Done.\n\n${BLOCK}`);
		const [end] = harness.eventsOfType("message_end").filter((event) => event.message.role === "assistant");
		expect(toJsonEvent(end)).toMatchObject({ handoffs: [{ now: "Report the fix.", next: "Open the PR." }] });
		const rpcEnd = records.find(
			(record) =>
				Reflect.get(record, "type") === "message_end" &&
				Reflect.get(Reflect.get(record, "message"), "role") === "assistant",
		);
		expect(rpcEnd).toMatchObject({ handoffs: [{ ask: "fix the login redirect", contentIndex: 0 }] });
		const persisted = harness.session.messages.at(-1);
		expect(persisted).toMatchObject({ content: [{ type: "text", text: `Done.\n\n${BLOCK}` }] });
		expect(persisted).not.toHaveProperty("handoffs");
	});

	it("an answer without a block is emitted byte-identically, with no handoffs field", async () => {
		const { harness, records } = await replyWith(ANSWER);
		const [end] = harness.eventsOfType("message_end").filter((event) => event.message.role === "assistant");
		expect(toJsonEvent(end)).toBe(end);
		expect(JSON.stringify(toJsonEvent(end))).toBe(JSON.stringify(end));
		expect(records.some((record) => Object.hasOwn(record, "handoffs"))).toBe(false);
	});
});
