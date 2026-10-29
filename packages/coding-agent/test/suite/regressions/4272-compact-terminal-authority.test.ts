import type { AssistantMessageEvent, ToolCall } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { startIdentity } from "../compact-storage-support.ts";
import { assistant } from "./4272-seeded-json-fixtures.ts";
import { seededOwner } from "./4272-seeded-owner-support.ts";

// senpi#4272 / T6 terminal authority: message-level records own public metadata, and every terminal replaces content.
it("T6 owns message metadata, usage and correlation from the seeded start through indexed updates", async () => {
	await using owner = await seededOwner();
	const { state, partial } = owner;
	const start: AssistantMessageEvent = { type: "start", partial };
	owner.message(start, "message_start", { correlation: { clientMessageId: "client-1" } });
	owner.message(start);
	partial.responseId = "resp-1";
	partial.content.push({ type: "text", text: "Hé" });
	owner.pushUpdate({ type: "text_start", contentIndex: 0, partial });
	const before = state.freeze();
	delete partial.responseId;
	partial.usage.output = 9;
	partial.content.push({ type: "thinking", thinking: "" });
	owner.pushUpdate({ type: "thinking_start", contentIndex: 1, partial });
	owner.pushUpdate({ type: "text_delta", contentIndex: 0, delta: "!", partial });
	partial.model = "mutated-after-acceptance";
	try {
		expect((await state.read(before)).messages).toMatchObject([
			{
				messageId: "message",
				correlation: { clientMessageId: "client-1" },
				message: {
					role: "assistant",
					model: "fixture",
					responseId: "resp-1",
					usage: { output: 2 },
					content: [{ type: "text", text: "Hé" }],
				},
			},
		]);
		const [current] = (await owner.view()).messages;
		expect(current).toMatchObject({
			correlation: { clientMessageId: "client-1" },
			message: {
				model: "fixture",
				usage: { output: 9 },
				content: [
					{ type: "text", text: "Hé!" },
					{ type: "thinking", thinking: "" },
				],
			},
		});
		expect(current?.message).not.toHaveProperty("responseId");
	} finally {
		state.release(before);
	}
});

it("T6 a terminal rebuilds rewritten blocks and drops every index at or above rewrittenFrom", async () => {
	await using owner = await seededOwner();
	const { state, partial } = owner;
	owner.message({ type: "start", partial });
	const kept: ToolCall = { type: "toolCall", id: "kept", name: "read", arguments: {} };
	partial.content.push(kept);
	owner.push(
		{ type: "toolcall_start", contentIndex: 0, partial },
		{ rawArgumentPrefix: '{ "a" :1}', parsedThrough: 0 },
	);
	kept.arguments = { a: 1 };
	owner.push({ type: "toolcall_end", contentIndex: 0, toolCall: kept, partial });
	partial.content.push(
		{ type: "toolCall", id: "old", name: "read", arguments: {} },
		{ type: "text", text: "dropped" },
	);
	owner.push(
		{ type: "toolcall_start", contentIndex: 1, partial },
		{ rawArgumentPrefix: '{"stale":', parsedThrough: 0 },
	);
	owner.push({ type: "text_start", contentIndex: 2, partial });
	const before = state.freeze();
	partial.content = [kept, { type: "toolCall", id: "new", name: "write", arguments: { b: 2 } }];
	partial.usage.output = 4;
	const done: AssistantMessageEvent = { type: "done", reason: "toolUse", message: partial };
	owner.message(done, undefined, { rewrittenFrom: 1 });
	const rebuilt = {
		blocks: [
			{ contentIndex: 0, kind: "tool_arguments", text: '{ "a" :1}' },
			{ contentIndex: 1, kind: "tool_arguments", text: "" },
		],
		message: {
			usage: { output: 4 },
			content: [
				{ type: "toolCall", id: "kept", arguments: { a: 1 } },
				{ type: "toolCall", id: "new", name: "write", arguments: { b: 2 } },
			],
		},
	};
	try {
		expect((await state.read(before)).messages[0]?.blocks.map((block) => block.text)).toEqual([
			'{ "a" :1}',
			'{"stale":',
			"dropped",
		]);
		expect((await owner.view()).messages).toMatchObject([{ persistence: undefined, ...rebuilt }]);
		expect((await owner.view()).messages[0]?.message?.content).toHaveLength(2);
		owner.message(done, "message_end");
		expect((await owner.view()).messages).toMatchObject([{ persistence: "pending", ...rebuilt }]);
		expect((await owner.view()).messages[0]?.blocks).toHaveLength(2);
	} finally {
		state.release(before);
	}
});

it("T6 message_end repairs an invalidated block from the terminal without its abandoned stream", async () => {
	await using owner = await seededOwner();
	const { state, partial } = owner;
	owner.message({ type: "start", partial });
	const call: ToolCall = { type: "toolCall", id: "c", name: "read", arguments: { stale: true } };
	partial.content.push(call);
	owner.push({ type: "toolcall_start", contentIndex: 0, partial }, { rawArgumentPrefix: '{"p":', parsedThrough: 0 });
	owner.push({ type: "toolcall_delta", contentIndex: 0, delta: '"x"', partial }, { parsedThrough: 8 });
	const before = state.freeze();
	call.arguments = { p: "final" };
	const done: AssistantMessageEvent = { type: "done", reason: "toolUse", message: partial };
	owner.message(done);
	expect((await owner.view()).messages[0]).toMatchObject({
		blocks: [{ text: "" }],
		message: { content: [{ arguments: { p: "final" } }] },
	});
	owner.message(done, "message_end", { invalidatedBlocks: [0] });
	try {
		expect((await state.read(before)).messages[0]).toMatchObject({
			blocks: [{ text: '{"p":"x"' }],
			message: { content: [{ arguments: { p: "x" } }] },
		});
		expect((await owner.view()).messages).toMatchObject([
			{
				persistence: "pending",
				blocks: [{ kind: "tool_arguments", text: "" }],
				message: { content: [{ type: "toolCall", id: "c", arguments: { p: "final" } }] },
			},
		]);
	} finally {
		state.release(before);
	}
});

it("T6 installs direct error and toolResult terminals with no start and binds their first ordinal", async () => {
	await using owner = await seededOwner();
	const { state } = owner;
	const failed = { ...assistant(), stopReason: "error" as const, errorMessage: "boom" };
	failed.content.push({ type: "text", text: "partial" });
	owner.message({ type: "error", reason: "error", error: failed });
	const tool = startIdentity();
	state.accept({
		type: "seeded_message",
		...tool,
		messageId: "tool",
		record: {
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId: "c",
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 2,
			},
		},
	});
	expect((await owner.view()).messages).toMatchObject([
		{
			messageId: "tool",
			persistence: "pending",
			blocks: [],
			message: { role: "toolResult", content: [{ text: "ok" }] },
		},
		{
			messageId: "message",
			persistence: undefined,
			blocks: [{ text: "partial" }],
			message: { stopReason: "error", errorMessage: "boom", content: [{ type: "text", text: "partial" }] },
		},
	]);
	const sequence = state.acceptedSequence;
	expect(() =>
		state.accept({
			type: "seeded_message",
			...startIdentity(tool.firstOrdinal),
			messageId: "tool",
			record: { type: "message_start", message: { role: "user", content: "again", timestamp: 3 } },
		}),
	).toThrow(expect.objectContaining({ reason: "duplicate_or_stale_start" }));
	expect(() => owner.accept({ type: "text_delta", contentIndex: 0, offset: 7, delta: "!" })).toThrow(
		expect.objectContaining({ reason: "invalid_phase" }),
	);
	expect(state.acceptedSequence).toBe(sequence);
});

it("T6 rejects a restart after streaming, malformed cutoffs and a foreign epoch atomically", async () => {
	await using owner = await seededOwner();
	const { state, partial } = owner;
	const start: AssistantMessageEvent = { type: "start", partial };
	owner.message(start);
	partial.content.push({ type: "text", text: "a" });
	owner.push({ type: "text_start", contentIndex: 0, partial });
	const before = await owner.view();
	const sequence = state.acceptedSequence;
	expect(() => owner.message(start)).toThrow(expect.objectContaining({ reason: "invalid_phase" }));
	const done: AssistantMessageEvent = { type: "done", reason: "stop", message: partial };
	for (const cut of [
		{ rewrittenFrom: -1 },
		{ rewrittenFrom: 0.5 },
		{ rewrittenFrom: Number.NaN },
		{ invalidatedBlocks: [-1] },
		{ invalidatedBlocks: [1.5] },
	])
		expect(() => owner.message(done, undefined, cut)).toThrow(
			expect.objectContaining({ reason: "invalid_terminal" }),
		);
	expect(() =>
		state.accept({
			type: "seeded_message",
			messageId: "message",
			epoch: "foreign",
			ordinal: 1_000_000,
			firstOrdinal: 1_000_000,
			record: owner.record(done),
		}),
	).toThrow(expect.objectContaining({ reason: "wrong_epoch" }));
	expect(state.acceptedSequence).toBe(sequence);
	expect(await owner.view()).toEqual(before);
});
