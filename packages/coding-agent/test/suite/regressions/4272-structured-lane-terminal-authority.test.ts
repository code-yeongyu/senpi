import { carryAssistantCapture, getAssistantCapture } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { wrapStreamWithKimiThinkingRecovery } from "../../../../ai/src/tool-call-middleware/protocols/kimi-xtml/thinking-recovery-stream.ts";
import { subscribeStructuredSessionRecords } from "../../../src/modes/rpc/structured-session-records.ts";
import {
	firstAssistantMessage,
	type Lane,
	type ScriptedSession,
	scriptedSession,
	textReply,
} from "../structured-lane-support.ts";

const sessions: ScriptedSession[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) await session.close();
});

// #4272, RULING-18a: Kimi removes markers only at terminal time; streamed content is not terminal authority.
it("T6 replaces streamed block CONTENT from the Kimi recovery terminal: hi<|open|>response there becomes hi there", async () => {
	const session = await scriptedSession([textReply("hi<|open|>response there")]);
	sessions.push(session);
	const provider = session.harness.agent.streamFunction;
	session.harness.agent.streamFunction = async (model, context, options) =>
		wrapStreamWithKimiThinkingRecovery(await provider(model, context, options));
	const records: Lane[] = [];
	const stop = subscribeStructuredSessionRecords(session.harness.session, (record) => records.push(record));
	try {
		await session.prompt("go");
	} finally {
		stop();
	}
	const turn = firstAssistantMessage(records);
	let content: object[] = [];
	for (const record of turn) {
		const event = record.assistantMessageEvent;
		if (event?.type === "text_end" && "block" in event && typeof event.block === "object" && event.block !== null)
			content = [event.block];
		if (record.type === "message_end") content = record.message?.content ?? [];
	}
	expect(
		turn.find((record) => record.assistantMessageEvent?.type === "text_end")?.assistantMessageEvent,
	).toMatchObject({ block: { type: "text", text: "hi<|open|>response there" } });
	expect(content).toEqual([{ type: "text", text: "hi there" }]);
	expect(turn.at(-1)?.message?.content).toEqual([{ type: "text", text: "hi there" }]);
	expect(turn.at(-1)?.invalidatedBlocks).toBeUndefined();
});

// #4272, RULING-18 condition 2(a): a capture object alone does not prove that the reader has a terminal message.
it("T6 invalidates ALL turn blocks when the reader cannot interpret a terminal capture", async () => {
	const session = await scriptedSession([
		(stream, partial) => {
			stream.push({ type: "start", partial });
			for (const text of ["first", "second"]) {
				const contentIndex = partial.content.length;
				partial.content.push({ type: "text", text });
				stream.push({ type: "text_start", contentIndex, partial });
				stream.push({ type: "text_end", contentIndex, content: text, partial });
			}
		},
	]);
	sessions.push(session);
	const subscribe = session.harness.session.subscribeStructured.bind(session.harness.session);
	let blockRecord: object | undefined;
	let injected = false;
	vi.spyOn(session.harness.session, "subscribeStructured").mockImplementation((listener) =>
		subscribe((record) => {
			if (record.type === "message_update") blockRecord = record;
			if (record.type === "message_end" && record.message.role === "assistant" && blockRecord) {
				// Inject an existing, typed nonterminal capture at the real reader boundary, not a fake gate result.
				carryAssistantCapture(blockRecord, record);
				expect(getAssistantCapture(record)).toBeDefined();
				expect(getAssistantCapture(record)?.message).toBeUndefined();
				injected = true;
			}
			listener(record);
		}),
	);
	const records: Lane[] = [];
	const stop = subscribeStructuredSessionRecords(session.harness.session, (record) => records.push(record));
	try {
		await session.prompt("go");
	} finally {
		stop();
	}
	expect(injected).toBe(true);
	expect(firstAssistantMessage(records).at(-1)?.invalidatedBlocks).toEqual([0, 1]);
});
