import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MEDIA_PLACEHOLDERS_CAPABILITY } from "../../src/modes/rpc/custom-capability.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";

const digest = (line: string) => createHash("sha256").update(line).digest("hex");
const start = { type: "message_start", message: { role: "assistant", content: [] } };

function connect(
	writer: SessionEventWriter,
	id: string,
	writeRaw: (line: string) => void,
	capabilities: string[] = [],
) {
	const close = vi.fn();
	writer.registerConnection(id, { writeRaw, waitForBackpressure: async () => {}, close });
	writer.setConnectionCapabilities(id, capabilities);
	writer.attachConnectionToSession(id, "s");
	return close;
}

// The in-process session binding parses each incoming JSONL record before enqueueing.
async function emitParsed(writer: SessionEventWriter, value: object) {
	writer.enqueue("s", JSON.parse(JSON.stringify(value)));
	await writer.flush();
}

describe("RPC immutable boundary replay", () => {
	it("replays an expanded boundary history larger than the queue cap without cutting a healthy peer", async () => {
		const writer = new SessionEventWriter(() => {});
		const expected: string[] = [];
		connect(writer, "source", (line) => {
			if (!line.includes('"type":"toolcall_delta"')) expected.push(digest(line));
		});
		await emitParsed(writer, start);
		const content: object[] = [];
		for (let i = 0; i < 128; i++) {
			const call = { type: "toolCall", id: `call-${i}`, name: "read", arguments: {} };
			content.push(call);
			const message = { role: "assistant", content, usage: { input: 11, output: i }, timestamp: 123 };
			await emitParsed(writer, {
				type: "message_update",
				message,
				assistantMessageEvent: { type: "toolcall_start", contentIndex: i, partial: message },
			});
			call.arguments = { payload: `${i}:${"x".repeat(4096)}` };
			await emitParsed(writer, {
				type: "message_update",
				message,
				assistantMessageEvent: {
					type: "toolcall_delta",
					contentIndex: i,
					delta: JSON.stringify(call.arguments),
					partial: message,
				},
			});
			await emitParsed(writer, {
				type: "message_update",
				message,
				assistantMessageEvent: { type: "toolcall_end", contentIndex: i, toolCall: call, partial: message },
			});
		}
		const actual: string[] = [];
		let bytes = 0;
		let deltas = 0;
		const close = connect(writer, "late", (line) => {
			bytes += Buffer.byteLength(line);
			if (line.includes('"type":"toolcall_delta"')) deltas++;
			else actual.push(digest(line));
		});
		await writer.flushConnection("late");
		expect(close).not.toHaveBeenCalled();
		expect(bytes).toBeGreaterThan(64 * 1024 * 1024);
		expect(actual).toEqual(expected);
		expect(deltas).toBe(128);
	});

	it("captures exact normalized wire values before caller mutation or another toJSON invocation", async () => {
		const writer = new SessionEventWriter(() => {});
		const expected: string[] = [];
		connect(writer, "source", (line) => expected.push(line));
		await emitParsed(writer, start);
		let calls = 0;
		const nested = {
			text: "before",
			toJSON() {
				calls++;
				return { text: this.text, calls, missing: undefined, number: NaN };
			},
		};
		writer.enqueue("s", {
			type: "message_update",
			message: { content: [nested] },
			assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, partial: { nested } },
			metadata: { __proto__: null, constructor: "safe", text: "\ud800\u2028", zero: -0 },
		});
		await writer.flush();
		const callsAfterLive = calls;
		nested.text = "after";
		const actual: string[] = [];
		connect(writer, "late", (line) => actual.push(line));
		await writer.flushConnection("late");
		expect(actual).toEqual(expected);
		expect(calls).toBe(callsAfterLive);
	});

	it("derives late media placeholders from the immutable boundary record", async () => {
		const writer = new SessionEventWriter(() => {});
		connect(writer, "source", () => {});
		await emitParsed(writer, start);
		const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
		writer.enqueue("s", { type: "tool_execution_end", toolCallId: "call", result: { content: [image] } });
		await writer.flush();
		image.data = "YWJj";
		const lines: string[] = [];
		connect(writer, "late", (line) => lines.push(line), [MEDIA_PLACEHOLDERS_CAPABILITY]);
		await writer.flushConnection("late");
		expect(JSON.parse(lines[1]!).result.content[0]).toEqual({
			type: "image_ref",
			mimeType: "image/png",
			byteLength: 5,
			ref: { toolCallId: "call", contentIndex: 0 },
		});
	});
	it("keeps the attach-time replay ahead of live updates and message completion", async () => {
		const writer = new SessionEventWriter(() => {});
		const expected: string[] = [];
		connect(writer, "source", (line) => expected.push(line));
		await emitParsed(writer, start);
		const message = { role: "assistant", content: [{ type: "text", text: "a" }] };
		await emitParsed(writer, {
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "a", partial: message },
		});
		await emitParsed(writer, {
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "a", partial: message },
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const actual: string[] = [];
		writer.registerConnection("late", { writeRaw: (line) => actual.push(line), waitForBackpressure: () => gate });
		writer.attachConnectionToSession("late", "s");
		message.content[0]!.text = "ab";
		writer.enqueue("s", {
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "b", partial: message },
		});
		writer.enqueue("s", { type: "message_end", message });
		await writer.flushConnection("source");
		expect(actual).toHaveLength(1);
		release();
		await writer.flushConnection("late");
		expect(actual).toEqual(expected);
		const after: string[] = [];
		connect(writer, "after", (line) => after.push(line));
		await writer.flushConnection("after");
		expect(after).toEqual([]);
	});
	it("preserves the exact already-emitted placeholder variant when toJSON has state", async () => {
		const writer = new SessionEventWriter(() => {});
		const expectedPlain: string[] = [];
		const expectedMedia: string[] = [];
		connect(writer, "source", (line) => expectedPlain.push(line));
		connect(writer, "media", (line) => expectedMedia.push(line), [MEDIA_PLACEHOLDERS_CAPABILITY]);
		await emitParsed(writer, start);
		let calls = 0;
		writer.enqueue("s", {
			type: "tool_execution_end",
			toolCallId: "call",
			result: {
				content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
				metadata: { toJSON: () => ({ version: ++calls }) },
			},
		});
		await writer.flush();
		const emittedCalls = calls;
		const actualPlain: string[] = [];
		const actualMedia: string[] = [];
		connect(writer, "late-plain", (line) => actualPlain.push(line));
		connect(writer, "late-media", (line) => actualMedia.push(line), [MEDIA_PLACEHOLDERS_CAPABILITY]);
		await writer.flush();
		expect(actualPlain).toEqual(expectedPlain);
		expect(actualMedia).toEqual(expectedMedia);
		expect(calls).toBe(emittedCalls);
	});
});
