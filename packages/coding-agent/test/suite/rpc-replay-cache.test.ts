import { describe, expect, it, vi } from "vitest";
import {
	MEDIA_PLACEHOLDERS_CAPABILITY,
	RENDERED_COMPONENTS_CAPABILITY,
} from "../../src/modes/rpc/custom-capability.ts";
import { RENDERED_COMPONENT_RECORD, SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";

type Record = {
	type: string;
	message?: { content: Array<{ text: string }> } | null;
	assistantMessageEvent?: { type: string; contentIndex: number; delta?: string; partial?: unknown };
	result?: { content: Array<{ type: string; data?: string }> };
};

const start = { type: "message_start", message: { role: "assistant", content: [] } };

function delta(text: string, fragment: string, type = "text_delta", contentIndex = 0) {
	const message = { role: "assistant", content: [{ type: "text", text }] };
	return {
		type: "message_update",
		message,
		assistantMessageEvent: { type, contentIndex, delta: fragment, partial: message },
	};
}

function connect(writer: SessionEventWriter, id: string, capabilities: string[] = []) {
	const records: Record[] = [];
	let bytes = 0;
	const close = vi.fn();
	writer.registerConnection(id, {
		writeRaw(line) {
			bytes += Buffer.byteLength(line);
			records.push(JSON.parse(line) as Record);
		},
		waitForBackpressure: async () => {},
		close,
	});
	writer.setConnectionCapabilities(id, capabilities);
	writer.attachConnectionToSession(id, "s");
	return { records, close, bytes: () => bytes };
}

function sourceWriter() {
	const writer = new SessionEventWriter(() => {});
	let liveUpdates = 0;
	let liveFullSnapshots = 0;
	writer.registerConnection("source", {
		writeRaw(line) {
			const record = JSON.parse(line) as Record;
			if (record.type === "message_update") {
				liveUpdates++;
				if (record.message && record.assistantMessageEvent?.partial) liveFullSnapshots++;
			}
		},
		waitForBackpressure: async () => {},
	});
	writer.attachConnectionToSession("source", "s");
	return { writer, liveCounts: () => ({ liveUpdates, liveFullSnapshots }) };
}

async function emit(writer: SessionEventWriter, record: object) {
	writer.enqueue("s", record);
	await writer.flush();
}

async function stream(writer: SessionEventWriter, count: number, fragment = "x".repeat(64)) {
	await emit(writer, start);
	let text = "";
	for (let i = 0; i < count; i++) {
		text += fragment;
		await emit(writer, delta(text, fragment));
	}
	return text;
}

describe("RPC replay cache", () => {
	it("replays a 64 KiB streamed response without overflowing a healthy late reader", async () => {
		const { writer, liveCounts } = sourceWriter();
		const text = await stream(writer, 1024);
		const late = connect(writer, "late");
		await writer.flushConnection("late");

		expect(late.close).not.toHaveBeenCalled();
		expect(late.records).toHaveLength(1025);
		expect(late.records.map((record) => record.assistantMessageEvent?.delta ?? "").join("")).toBe(text);
		expect(late.records.at(-1)?.message?.content[0]?.text).toBe(text);
		expect(late.bytes()).toBeLessThan(1024 * 1024);
		// Retained history changes; the stream an already attached client receives does not.
		expect(liveCounts()).toEqual({ liveUpdates: 1024, liveFullSnapshots: 1024 });
	});

	it("retains linear replay bytes and only the newest full delta snapshot", async () => {
		const sizes: number[] = [];
		for (const count of [256, 512]) {
			const { writer } = sourceWriter();
			await stream(writer, count);
			const late = connect(writer, "late");
			await writer.flushConnection("late");
			const updates = late.records.filter((record) => record.type === "message_update");
			expect(updates.filter((record) => record.message !== null)).toHaveLength(1);
			expect(updates.slice(0, -1).every((record) => record.assistantMessageEvent?.partial === null)).toBe(true);
			sizes.push(late.bytes());
		}
		expect(sizes[1]! / sizes[0]!).toBeLessThan(2.1);
	});

	it("preserves delta and control ordering across thinking and tool-call blocks", async () => {
		const { writer } = sourceWriter();
		const events = [
			start,
			delta("think", "think", "thinking_delta"),
			{ type: "extension_ui_request", method: "setStatus", key: "test", text: "busy" },
			delta("thinking", "ing", "thinking_delta"),
			{ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0 } },
			{ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 } },
			delta('{"a":', '{"a":', "toolcall_delta", 1),
			delta('{"a":1}', "1}", "toolcall_delta", 1),
		];
		for (const event of events) await emit(writer, event);
		const late = connect(writer, "late");
		await writer.flushConnection("late");
		expect(late.records.map((record) => record.assistantMessageEvent?.type ?? record.type)).toEqual(
			events.map((record) => ("assistantMessageEvent" in record ? record.assistantMessageEvent?.type : record.type)),
		);
		expect(late.records.flatMap((record) => record.assistantMessageEvent?.delta ?? [])).toEqual([
			"think",
			"ing",
			'{"a":',
			"1}",
		]);
		expect(late.records.at(-1)?.message?.content[0]?.text).toBe('{"a":1}');
	});

	it("preserves full boundary snapshots and tool identity across many tool-call blocks", async () => {
		const { writer } = sourceWriter();
		await emit(writer, start);
		const boundaries: object[] = [];
		const content: object[] = [];
		for (let i = 0; i < 32; i++) {
			const call = { type: "toolCall", id: `call-${i}`, name: "read", arguments: {} };
			content.push(call);
			const beginMessage = { role: "assistant", content: structuredClone(content) };
			const begin = {
				type: "message_update",
				message: beginMessage,
				assistantMessageEvent: { type: "toolcall_start", contentIndex: i, partial: beginMessage },
			};
			boundaries.push(begin);
			await emit(writer, begin);
			call.arguments = { path: `file-${i}`, text: "x".repeat(1024) };
			const message = { role: "assistant", content: structuredClone(content) };
			await emit(writer, {
				type: "message_update",
				message,
				assistantMessageEvent: {
					type: "toolcall_delta",
					contentIndex: i,
					delta: JSON.stringify(call.arguments),
					partial: message,
				},
			});
			const end = {
				type: "message_update",
				message,
				assistantMessageEvent: { type: "toolcall_end", contentIndex: i, toolCall: call, partial: message },
			};
			boundaries.push(end);
			await emit(writer, end);
		}
		const late = connect(writer, "late");
		await writer.flushConnection("late");
		expect(late.close).not.toHaveBeenCalled();
		const replayBoundaries = late.records.filter((record) =>
			["toolcall_start", "toolcall_end"].includes(record.assistantMessageEvent?.type ?? ""),
		);
		// Older host-attached TUI clients require full boundary snapshots and read tool
		// identity from partial. Only compact deltas may use the existing null form.
		expect(replayBoundaries).toEqual(boundaries.map((record) => ({ ...record, sessionId: "s" })));
		const updates = late.records.filter((record) => record.assistantMessageEvent?.type === "toolcall_delta");
		expect(updates).toHaveLength(32);
		expect(updates.slice(0, -1).every((record) => record.message === null)).toBe(true);
		expect(updates.at(-1)?.message).toEqual({ role: "assistant", content });
	});

	it("releases replay history across repeated completed turns", async () => {
		const { writer } = sourceWriter();
		for (let turn = 0; turn < 12; turn++) {
			await stream(writer, 32, `turn-${turn}:`);
			await emit(writer, { ...start, type: "message_end" });
			const late = connect(writer, "late");
			await writer.flushConnection("late");
			expect(late.records).toEqual([]);
			writer.unregisterConnection("late");
		}
		await stream(writer, 2, "new");
		const late = connect(writer, "late");
		await writer.flushConnection("late");
		expect(late.records).toHaveLength(3);
		expect(late.records.at(-1)?.message?.content[0]?.text).toBe("newnew");
	});

	it.each(["message_start", "text_start", "message_end", "forget"])("clears superseded state on %s", async (reset) => {
		const { writer } = sourceWriter();
		await stream(writer, 2, "old");
		if (reset === "forget") writer.forgetSession("s");
		else if (reset === "text_start") {
			await emit(writer, { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } });
		} else await emit(writer, { ...start, type: reset });
		if (reset === "message_start" || reset === "text_start") await emit(writer, delta("new", "new"));
		const late = connect(writer, "late");
		await writer.flushConnection("late");
		if (reset === "message_end" || reset === "forget") expect(late.records).toEqual([]);
		else {
			expect(late.records).toHaveLength(2);
			expect(late.records.at(-1)?.message?.content[0]?.text).toBe("new");
		}
	});

	it("preserves media placeholders and rendered capability filtering after compaction", async () => {
		const { writer } = sourceWriter();
		await emit(writer, start);
		await emit(writer, delta("a", "a"));
		const early = connect(writer, "early", [MEDIA_PLACEHOLDERS_CAPABILITY]);
		await writer.flushConnection("early");
		await emit(writer, {
			type: "tool_execution_end",
			toolCallId: "image",
			result: { content: [{ type: "image", data: "aGVsbG8gd29ybGQh", mimeType: "image/png" }] },
		});
		await emit(writer, { type: "rendered_component", [RENDERED_COMPONENT_RECORD]: true, lines: ["rendered"] });
		await emit(writer, delta("ab", "b"));
		const plain = connect(writer, "plain");
		const capable = connect(writer, "capable", [MEDIA_PLACEHOLDERS_CAPABILITY, RENDERED_COMPONENTS_CAPABILITY]);
		await writer.flush();
		expect(plain.records.find((record) => record.type === "tool_execution_end")?.result?.content[0]).toMatchObject({
			type: "image",
			data: "aGVsbG8gd29ybGQh",
		});
		expect(capable.records.find((record) => record.type === "tool_execution_end")?.result?.content[0]).toMatchObject({
			type: "image_ref",
		});
		expect(plain.records.some((record) => record.type === "rendered_component")).toBe(false);
		expect(capable.records.filter((record) => record.type === "rendered_component")).toHaveLength(1);
		for (const peer of [plain, capable]) {
			const updates = peer.records.filter((record) => record.type === "message_update");
			expect(updates.map((record) => record.assistantMessageEvent?.delta)).toEqual(["a", "b"]);
			expect(updates[0]?.message).toBeNull();
			expect(updates.at(-1)?.message?.content[0]?.text).toBe("ab");
		}
		expect(early.records[1]?.message?.content[0]?.text).toBe("a");
	});
});
