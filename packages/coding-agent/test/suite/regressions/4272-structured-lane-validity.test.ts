import { pushAssistantProgress, subscribeAssistantCapture, type ToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeStructuredSessionRecords } from "../../../src/modes/rpc/structured-session-records.ts";
import {
	firstAssistantMessage,
	type Lane,
	messageLabels,
	type Script,
	type ScriptedSession,
	scriptedSession,
	textReply,
} from "../structured-lane-support.ts";

const sessions: ScriptedSession[] = [];
afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close();
});

async function laneTurn(script: Script): Promise<Lane[]> {
	const session = await scriptedSession([script, textReply("ok")]);
	sessions.push(session);
	const records: Lane[] = [];
	const stop = subscribeStructuredSessionRecords(
		session.harness.session,
		(record) => records.push(record),
		(cause) => {
			throw cause;
		},
	);
	try {
		await session.prompt("go");
	} finally {
		stop();
	}
	return firstAssistantMessage(records);
}

describe("T6 structured lane block validity", () => {
	it("T6 gives a lane attached mid-message no seed, delta or control for that message (late attach)", async () => {
		const releaseCapture = subscribeAssistantCapture();
		const resume = Promise.withResolvers<void>();
		const paused: Script = async (stream, partial) => {
			stream.push({ type: "start", partial });
			partial.content.push({ type: "text", text: "a" });
			stream.push({ type: "text_start", contentIndex: 0, partial });
			await resume.promise;
			const block = partial.content[0];
			if (block?.type === "text") block.text = "ab";
			stream.push({ type: "text_delta", contentIndex: 0, delta: "b", partial });
			pushAssistantProgress(stream, { type: "message_block_metadata", contentIndex: 0, textSignature: "sig" });
			const native = { type: "providerNative" as const, subtype: "fixture", raw: {} };
			partial.content.push(native);
			pushAssistantProgress(stream, {
				type: "message_block_state",
				contentIndex: 1,
				phase: "insert",
				block: native,
			});
			pushAssistantProgress(stream, { type: "message_block_state", contentIndex: 1, phase: "end", block: native });
			stream.push({ type: "text_end", contentIndex: 0, content: "ab", partial });
		};
		const session = await scriptedSession([paused, textReply("next")]);
		sessions.push(session);
		const emitted = Promise.withResolvers<void>();
		const stopWatch = session.harness.session.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_start") emitted.resolve();
		});
		const records: Lane[] = [];
		const early: Lane[] = [];
		const stopEarly = subscribeStructuredSessionRecords(
			session.harness.session,
			(record) => early.push(record),
			(cause) => {
				throw cause;
			},
		);
		let stop = () => {};
		try {
			const running = session.prompt("first");
			await emitted.promise;
			stop = subscribeStructuredSessionRecords(
				session.harness.session,
				(record) => records.push(record),
				(cause) => {
					throw cause;
				},
			);
			resume.resolve();
			await running;
			expect(messageLabels(firstAssistantMessage(early))).toEqual([
				"message_start",
				"message_update:text_start",
				"message_update:text_delta",
				"message_block_metadata",
				"message_block_state:insert",
				"message_block_state:end",
				"message_update:text_end",
				"message_end",
			]);
			const late = records.filter((record) => record.type?.startsWith("message_"));
			expect(messageLabels(late)).toEqual(["message_end"]);
			expect(late[0]?.invalidatedBlocks).toBeUndefined();
			records.length = 0;
			await session.prompt("second");
			expect(messageLabels(firstAssistantMessage(records))).toEqual([
				"message_start",
				"message_update:text_start",
				"message_update:text_delta",
				"message_update:text_end",
				"message_end",
			]);
		} finally {
			stop();
			stopEarly();
			stopWatch();
			releaseCapture();
		}
	});

	it("T6 invalidates a block whose seed was seen but whose end capture failed (LOW a)", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const failing: Script = (stream, partial) => {
			stream.push({ type: "start", partial });
			const call: ToolCall = { type: "toolCall", id: "call_1", name: "probe", arguments: {} };
			partial.content.push(call);
			stream.push({ type: "toolcall_start", contentIndex: 0, partial });
			stream.push({ type: "toolcall_delta", contentIndex: 0, delta: '{"a":1}', partial });
			Reflect.set(call.arguments, "uncloneable", () => 1);
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial });
			partial.stopReason = "toolUse";
		};
		try {
			const turn = await laneTurn(failing);
			expect(messageLabels(turn)).toEqual([
				"message_start",
				"message_update:toolcall_start",
				"message_update:toolcall_delta",
				"message_end",
			]);
			expect(turn.at(-1)?.invalidatedBlocks).toEqual([0]);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});

	it("T6 invalidates every block at or above a rewriting terminal's rewrittenFrom", async () => {
		const rewriting: Script = (stream, partial) => {
			stream.push({ type: "start", partial });
			partial.content.push({ type: "text", text: "a" });
			stream.push({ type: "text_start", contentIndex: 0, partial });
			stream.push({ type: "text_end", contentIndex: 0, content: "a", partial });
			const call: ToolCall = { type: "toolCall", id: "call_1", name: "probe", arguments: { a: 1 } };
			partial.content.push(call);
			stream.push({ type: "toolcall_start", contentIndex: 1, partial });
			stream.push({ type: "toolcall_end", contentIndex: 1, toolCall: call, partial });
			partial.content.push({ type: "text", text: "b" });
			stream.push({ type: "text_start", contentIndex: 2, partial });
			stream.push({ type: "text_end", contentIndex: 2, content: "b", partial });
			partial.content = partial.content.filter((block) => block.type !== "toolCall");
			stream.push({ type: "done", reason: "stop", message: partial }, { rewrittenFrom: 1 });
			stream.end(partial);
		};
		const turn = await laneTurn(rewriting);
		expect(messageLabels(turn)).toEqual([
			"message_start",
			"message_update:text_start",
			"message_update:text_end",
			"message_update:toolcall_start",
			"message_update:toolcall_end",
			"message_update:text_start",
			"message_update:text_end",
			"message_end",
		]);
		const end = turn.at(-1);
		expect(end?.invalidatedBlocks).toEqual([1, 2]);
		expect(end?.message?.content).toEqual([
			{ type: "text", text: "a" },
			{ type: "text", text: "b" },
		]);
	});

	it("T6 invalidates every block of a message that ends without a terminal capture", async () => {
		const unterminated: Script = (stream, partial) => {
			stream.push({ type: "start", partial });
			for (const text of ["a", "b"]) {
				const contentIndex = partial.content.length;
				partial.content.push({ type: "text", text });
				stream.push({ type: "text_start", contentIndex, partial });
				stream.push({ type: "text_end", contentIndex, content: text, partial });
			}
			stream.end(partial);
		};
		const turn = await laneTurn(unterminated);
		expect(messageLabels(turn)).toEqual([
			"message_start",
			"message_update:text_start",
			"message_update:text_end",
			"message_update:text_start",
			"message_update:text_end",
			"message_end",
		]);
		expect(turn.at(-1)?.invalidatedBlocks).toEqual([0, 1]);
	});
});
