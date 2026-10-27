import { type ToolCall } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { seededOwner } from "./4272-seeded-owner-support.ts";

// senpi#4272 / T6: public block values belong to the real owner, including after settlement.
it("T6 owns interleaved text, thinking, and tool ends independently of producer mutation", async () => {
	await using owner = await seededOwner();
	const { state, partial } = owner;
	const tool: ToolCall = { type: "toolCall", id: "c", name: "requested", arguments: { stale: true } };
	partial.content = [{ type: "text", text: "seed" }, { type: "thinking", thinking: "why" }, tool];
	owner.push({ type: "text_start", contentIndex: 0, partial });
	owner.push({ type: "thinking_start", contentIndex: 1, partial });
	owner.push({ type: "toolcall_start", contentIndex: 2, partial }, { rawArgumentPrefix: '{"x":', parsedThrough: 0 });
	const before = state.freeze();
	owner.push({ type: "thinking_delta", contentIndex: 1, delta: "?", partial });
	owner.push({ type: "text_delta", contentIndex: 0, delta: "!", partial });
	owner.push({ type: "toolcall_delta", contentIndex: 2, delta: "1}", partial }, { parsedThrough: 7 });
	partial.content[0] = { type: "text", text: "authoritative", textSignature: "signed" };
	partial.content[1] = { type: "thinking", thinking: "", redacted: true, thinkingSignature: "opaque" };
	tool.arguments = { final: 2 };
	owner.push({ type: "text_end", contentIndex: 0, content: "authoritative", partial });
	owner.push({ type: "thinking_end", contentIndex: 1, content: "", partial });
	owner.push({ type: "toolcall_end", contentIndex: 2, toolCall: tool, partial });
	state.accept({ type: "message_status", messageId: "message", persistence: "pending" });
	tool.arguments.final = 99;
	partial.content = [];
	await state.idle();
	try {
		expect((await state.read(before)).messages[0]).toMatchObject({
			message: {
				content: [
					{ type: "text", text: "seed" },
					{ type: "thinking", thinking: "why" },
					{ type: "toolCall", arguments: { stale: true } },
				],
			},
		});
		expect((await owner.view()).messages[0]).toMatchObject({
			persistence: "pending",
			blocks: [{ text: "authoritative" }, { text: "" }, { text: '{"x":1}' }],
			message: {
				content: [
					{ type: "text", text: "authoritative", textSignature: "signed" },
					{ type: "thinking", thinking: "", redacted: true, thinkingSignature: "opaque" },
					{ type: "toolCall", id: "c", name: "requested", arguments: { final: 2 } },
				],
			},
		});
	} finally {
		state.release(before);
	}
});

it("T6 retains independent parsed seeds and resets raw spelling with its explicit parse frontier", async () => {
	await using owner = await seededOwner();
	const { partial } = owner;
	partial.content.push({ type: "toolCall", id: "c", name: "tool", arguments: { stale: true } });
	owner.push({ type: "toolcall_start", contentIndex: 0, partial }, { rawArgumentPrefix: '{"x":', parsedThrough: 0 });
	owner.push({ type: "toolcall_delta", contentIndex: 0, delta: "1}", partial }, { parsedThrough: 0 });
	expect((await owner.view()).messages[0]).toMatchObject({
		blocks: [{ text: '{"x":1}' }],
		message: { content: [{ arguments: { stale: true } }] },
	});
	owner.control({
		type: "message_tool_arguments_reset",
		contentIndex: 0,
		rawArgumentPrefix: '{ "y":',
		parsedThrough: 0,
	});
	owner.accept({ type: "toolcall_delta", contentIndex: 0, offset: 6, delta: "2}", parsedThrough: 8 });
	expect((await owner.view()).messages[0]).toMatchObject({
		blocks: [{ text: '{ "y":2}' }],
		message: { content: [{ arguments: { y: 2 } }] },
	});
});

it("T6 applies native insertion, authoritative block state, and signature metadata to frozen blocks", async () => {
	await using owner = await seededOwner();
	const { partial, state } = owner;
	partial.content.push({ type: "thinking", thinking: "", thinkingSignature: "a" });
	owner.push({ type: "thinking_start", contentIndex: 0, partial });
	owner.control({ type: "message_block_metadata", contentIndex: 0, thinkingSignatureDelta: "b", startedAt: 1 });
	const before = state.freeze();
	owner.control({
		type: "message_block_metadata",
		contentIndex: 0,
		thinkingSignature: "",
		endedAt: 2,
		redacted: true,
	});
	owner.control({
		type: "message_block_state",
		contentIndex: 1,
		phase: "insert",
		block: { type: "providerNative", subtype: "fixture", raw: { value: "first" } },
	});
	owner.control({
		type: "message_block_state",
		contentIndex: 1,
		phase: "end",
		block: { type: "providerNative", subtype: "fixture", raw: { value: "final" } },
	});
	try {
		expect((await state.read(before)).messages[0]).toMatchObject({
			message: { content: [{ thinkingSignature: "ab", startedAt: 1 }] },
		});
		expect((await owner.view()).messages[0]).toMatchObject({
			message: {
				content: [
					{ thinking: "", thinkingSignature: "", startedAt: 1, endedAt: 2, redacted: true },
					{ type: "providerNative", subtype: "fixture", raw: { value: "final" } },
				],
			},
		});
	} finally {
		state.release(before);
	}
});

it.each([
	[{ type: "thinking_delta", contentIndex: 0, offset: 1, delta: "?" }, "wrong_kind"],
	[{ type: "message_tool_arguments_reset", contentIndex: 0, rawArgumentPrefix: "", parsedThrough: 0 }, "wrong_kind"],
	[{ type: "message_block_metadata", contentIndex: 0, thinkingSignatureDelta: "x" }, "wrong_kind"],
	[{ type: "text_delta", contentIndex: 3, offset: 0, delta: "?" }, "unknown_block"],
] as const)("T6 rejects an incompatible block operation %# atomically", async (event, reason) => {
	await using owner = await seededOwner();
	const { partial } = owner;
	partial.content.push({ type: "text", text: "a" });
	owner.push({ type: "text_start", contentIndex: 0, partial });
	const before = await owner.view();
	expect(() => owner.accept(event)).toThrow(expect.objectContaining({ reason }));
	expect(await owner.view()).toEqual(before);
});

it("T6 rejects deltas after block end and invalid parse frontiers", async () => {
	await using owner = await seededOwner();
	const { partial } = owner;
	const tool: ToolCall = { type: "toolCall", id: "c", name: "t", arguments: {} };
	partial.content.push(tool);
	owner.push({ type: "toolcall_start", contentIndex: 0, partial }, { rawArgumentPrefix: "{}", parsedThrough: 2 });
	const before = await owner.view();
	for (const parsedThrough of [-1, 0, 3, 0.5, NaN])
		expect(() =>
			owner.accept({ type: "toolcall_delta", contentIndex: 0, offset: 2, delta: "", parsedThrough }),
		).toThrow(expect.objectContaining({ reason: "invalid_parse_frontier" }));
	expect(await owner.view()).toEqual(before);
	owner.push({ type: "toolcall_end", contentIndex: 0, toolCall: tool, partial });
	expect(() =>
		owner.accept({ type: "toolcall_delta", contentIndex: 0, offset: 2, delta: "", parsedThrough: 2 }),
	).toThrow(expect.objectContaining({ reason: "invalid_phase" }));
});
