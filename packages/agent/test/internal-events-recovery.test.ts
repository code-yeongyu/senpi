import {
	assistantRecords,
	getAssistantCapture,
	isAssistantProgress,
	normalizeContext,
	subscribeAssistantCapture,
	wrapStreamWithModelRecovery,
	type AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { withEmptyAssistantRecovery } from "../src/empty-assistant-recovery.ts";
import { createInternalAgentChannel, type OrderedAgentRecord } from "../src/internal-events.ts";
import {
	attempt,
	model,
	claude,
	bash,
	bashSchema,
	claudeTurnWithInvokeInProse,
	progressOf,
	withTimingValuesMasked,
} from "./internal-events-recovery-fixture.ts";

let releaseCapture = () => {};
beforeEach(() => {
	releaseCapture = subscribeAssistantCapture();
});
afterEach(() => releaseCapture());

describe("empty-assistant recovery relays capture records #4272", () => {
	it("keeps the public bytes recorded before capture", async () => {
		let calls = 0;
		const create = withEmptyAssistantRecovery(model, () => attempt("discard-me", ++calls === 1 ? "" : "kept").stream);
		const wrapped = await create(model, normalizeContext({ messages: [] }), {});
		const events: AssistantMessageEvent[] = [];
		for await (const event of wrapped) events.push(event);
		expect(JSON.stringify(events).replace(/"timestamp":\d+/g, '"timestamp":0')).toMatchSnapshot();
	});

	it("forwards the kept attempt's own records and none from the discarded attempt", async () => {
		const first = attempt("discard-me", "");
		const second = attempt("kept", "kept");
		let calls = 0;
		const create = withEmptyAssistantRecovery(model, () => (++calls === 1 ? first.stream : second.stream));
		const wrapped = await create(model, normalizeContext({ messages: [] }), {});
		const records = [];
		for await (const record of assistantRecords(wrapped)) records.push(record);
		expect(calls).toBe(2);
		expect(records.filter(isAssistantProgress)).toEqual([
			{ type: "message_block_metadata", contentIndex: 0, thinkingSignatureDelta: "kept" },
		]);
		const events = records.filter((record) => !isAssistantProgress(record));
		expect(events.slice(0, -1)).toHaveLength(second.pushed.length - 1);
		events.slice(0, -1).forEach((event, index) => {
			expect(event).toBe(second.pushed[index]);
			expect(getAssistantCapture(event)).toBeDefined();
		});
		expect(events.some((event) => first.pushed.includes(event))).toBe(false);
		const done = events.at(-1);
		if (done?.type !== "done") throw new Error("expected done");
		const terminal = getAssistantCapture(done);
		expect(terminal?.message).toEqual(done.message);
		expect(terminal?.message?.diagnostics?.map((diagnostic) => diagnostic.type)).toEqual([
			"empty_assistant_response_recovery",
		]);
		expect(terminal?.metadata?.diagnostics).toEqual(done.message.diagnostics);
	});

	it("drops both attempts' controls when the retry is empty too: the error terminal has no block they name", async () => {
		let calls = 0;
		const create = withEmptyAssistantRecovery(model, () => attempt(++calls === 1 ? "first" : "second", "").stream);
		const wrapped = await create(model, normalizeContext({ messages: [] }), {});
		const records = [];
		for await (const record of assistantRecords(wrapped)) records.push(record);
		expect(calls).toBe(2);
		// Both controls named thinking block 0; the terminal's block 0 is the error text, so neither may cross.
		expect(records.filter(isAssistantProgress)).toEqual([]);
		const terminal = records.at(-1);
		if (records.length !== 1 || terminal?.type !== "error") throw new Error("expected a lone error terminal");
		expect(terminal.error.content.map((block) => block.type)).toEqual(["text"]);
	});

	it("delivers the kept attempt's controls and the agent's thinking timing to the internal channel", async () => {
		let calls = 0;
		const internalChannel = createInternalAgentChannel();
		const agent = new Agent({
			internalChannel,
			initialState: { model },
			streamFn: () => (++calls === 1 ? attempt("discard-me", "") : attempt("kept", "kept")).stream,
		});
		const records: OrderedAgentRecord[] = [];
		const unsubscribe = internalChannel.subscribe((record) => {
			records.push(record);
		});
		try {
			await agent.prompt("fixture");
			expect(calls).toBe(2);
			expect(progressOf(records).map(withTimingValuesMasked)).toEqual([
				{ type: "message_block_metadata", contentIndex: 0, startedAt: "set" },
				{ type: "message_block_metadata", contentIndex: 0, thinkingSignatureDelta: "kept" },
				{ type: "message_block_metadata", contentIndex: 0, startedAt: "set", endedAt: "set" },
			]);
			const updates = records.flatMap((record) =>
				"event" in record && record.event.type === "message_update" ? [record.event] : [],
			);
			expect(updates.length).toBeGreaterThan(0);
			expect(updates.filter((event) => getAssistantCapture(event) === undefined)).toEqual([]);
		} finally {
			unsubscribe();
		}
	});
});

describe("a Claude id behind both recovery wrappers #4272", () => {
	it("receives its records at the indices of the message it reads", async () => {
		let turn = 0;
		const internalChannel = createInternalAgentChannel();
		const agent = new Agent({
			internalChannel,
			initialState: { model: claude, tools: [bash] },
			streamFn: () => wrapStreamWithModelRecovery(claudeTurnWithInvokeInProse(++turn > 1), claude, [bashSchema]),
		});
		const records: OrderedAgentRecord[] = [];
		const unsubscribe = internalChannel.subscribe((record) => {
			records.push(record);
		});
		try {
			await agent.prompt("fixture");
			expect(turn).toBe(2);
			const firstEnd = records.findIndex(
				(record) =>
					"event" in record && record.event.type === "message_end" && record.event.message.role === "assistant",
			);
			const firstTurn = records.slice(0, firstEnd + 1);
			const end = firstTurn.at(-1);
			if (!end || !("event" in end) || end.event.type !== "message_end" || end.event.message.role !== "assistant")
				throw new Error("no assistant message_end");
			expect(end.event.message.content.map((block) => block.type)).toEqual([
				"thinking",
				"text",
				"toolCall",
				"text",
				"providerNative",
			]);
			expect(progressOf(firstTurn).map(withTimingValuesMasked)).toEqual([
				{ type: "message_block_metadata", contentIndex: 0, startedAt: "set" },
				{ type: "message_block_metadata", contentIndex: 0, thinkingSignatureDelta: "sig" },
				{ type: "message_block_metadata", contentIndex: 0, startedAt: "set", endedAt: "set" },
				{
					type: "message_block_state",
					contentIndex: 4,
					phase: "insert",
					block: { type: "providerNative", subtype: "web_search_call", raw: { status: "in_progress" } },
				},
				{
					type: "message_block_state",
					contentIndex: 4,
					phase: "end",
					block: { type: "providerNative", subtype: "web_search_call", raw: { status: "completed" } },
				},
			]);
			const updates = firstTurn.flatMap((record) =>
				"event" in record && record.event.type === "message_update" ? [record.event] : [],
			);
			expect(
				updates.map(
					(event) =>
						`${event.assistantMessageEvent.type}:${"contentIndex" in event.assistantMessageEvent ? event.assistantMessageEvent.contentIndex : ""}`,
				),
			).toEqual([
				"thinking_start:0",
				"thinking_delta:0",
				"thinking_end:0",
				"text_start:1",
				"text_delta:1",
				"toolcall_start:2",
				"toolcall_delta:2",
				"toolcall_end:2",
				"text_delta:3",
				"text_end:3",
			]);
			expect(updates.filter((event) => getAssistantCapture(event) === undefined)).toEqual([]);
			expect(getAssistantCapture(end.event)?.message?.content.map((block) => block.type)).toEqual(
				end.event.message.content.map((block) => block.type),
			);
		} finally {
			unsubscribe();
		}
	});
});
