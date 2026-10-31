import { describe, expect, it, vi } from "vitest";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";

describe("3913 shared writer accounting", () => {
	it("walks only a linear number of bytes during a 3000-record burst", async () => {
		const writer = new SessionEventWriter(
			() => {},
			(_flush) => {},
		);
		const byteLength = vi.spyOn(Buffer, "byteLength");
		try {
			for (let index = 0; index < 3000; index++)
				expect(writer.enqueue("session", { type: "event", index })).toBe(true);
			expect(writer.bufferedRecordCount).toBe(3000);
			expect(writer.bufferedByteLength).toBeGreaterThan(0);
			expect(byteLength.mock.calls.length).toBeLessThanOrEqual(3000 * 4);
		} finally {
			byteLength.mockRestore();
			await writer.flush();
		}
		expect(writer.bufferedRecordCount).toBe(0);
		expect(writer.bufferedByteLength).toBe(0);
	});

	it("keeps byte totals exact through tool replacement and delta merging", async () => {
		const chunks: string[] = [];
		const writer = new SessionEventWriter(
			(chunk) => chunks.push(chunk),
			(_flush) => {},
		);
		for (let index = 0; index < 20; index++) {
			writer.enqueue("session", {
				type: "tool_execution_update",
				toolCallId: "tool",
				partialResult: "é".repeat(index),
			});
			writer.enqueue("session", {
				type: "message_update",
				message: { text: "é".repeat(index) },
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "é", partial: {} },
			});
		}
		const bytes = writer.bufferedByteLength;
		const count = writer.bufferedRecordCount;
		await writer.flush();
		expect(bytes).toBe(Buffer.byteLength(chunks.join("")));
		expect(count).toBe(chunks.length);
		expect(writer.bufferedByteLength).toBe(0);
		expect(writer.bufferedRecordCount).toBe(0);
	});

	it("delivers an admitted close response even when overflow already sealed the handle", async () => {
		const chunks: string[] = [];
		const writer = new SessionEventWriter(
			(chunk) => chunks.push(chunk),
			(_flush) => {},
		);
		writer.closeSession("session", { type: "response", command: "close_session", success: false });
		const reply = writer.reserveCloseResponse("session", {
			id: "close",
			type: "response",
			command: "close_session",
			success: true,
		});
		expect(reply).toBeDefined();
		reply?.complete(true, "client_close");
		await writer.flush();
		expect(chunks.map((chunk) => JSON.parse(chunk))).toContainEqual({
			sessionId: "session",
			id: "close",
			type: "response",
			command: "close_session",
			success: true,
		});
	});
});
