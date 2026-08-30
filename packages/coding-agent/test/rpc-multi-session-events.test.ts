import { describe, expect, it } from "vitest";
import { SessionEventWriter } from "../src/modes/rpc/session-event-writer.ts";
import { SessionExtensionUiRequests } from "../src/modes/rpc/session-extension-ui-requests.ts";

function records(chunks: readonly string[]): Array<Record<string, unknown>> {
	return chunks
		.join("")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function cumulativeTextUpdate(delta: string, text: string, contentIndex = 0): Record<string, unknown> {
	return {
		type: "message_update",
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex,
			delta,
			partial: { role: "assistant", content: [{ type: "text", text }] },
		},
		message: { role: "assistant", content: [{ type: "text", text }] },
	};
}

function flushedDeltas(output: readonly Record<string, unknown>[]): string {
	return output
		.filter((record) => record.type === "message_update")
		.map((record) => (record.assistantMessageEvent as { delta?: string }).delta ?? "")
		.join("");
}

function deferred<T = void>(): {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
} {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

describe("multi-session RPC event writer", () => {
	it("compacts 1000 stalled message snapshots without losing assistant transitions", async () => {
		const chunks: string[] = [];
		const scheduled: Array<() => void> = [];
		const writer = new SessionEventWriter(
			(chunk) => chunks.push(chunk),
			(flush) => scheduled.push(flush),
		);
		const source = Array.from({ length: 1000 }, (_, index) => String.fromCharCode(97 + (index % 26))).join("");
		let cumulative = "";
		let cumulativeBytes = 0;

		writer.enqueue("a", { type: "message_start", message: { role: "assistant", content: [] } });
		for (const delta of source) {
			cumulative += delta;
			const update = cumulativeTextUpdate(delta, cumulative);
			cumulativeBytes += Buffer.byteLength(`${JSON.stringify({ ...update, sessionId: "a" })}\n`);
			writer.enqueue("a", update);
		}
		writer.enqueue("a", {
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: source }] },
		});
		await scheduled[0]!();

		const output = records(chunks);
		const updates = output.filter((record) => record.type === "message_update");
		expect(output[0]?.type).toBe("message_start");
		expect(output.at(-1)?.type).toBe("message_end");
		expect(flushedDeltas(output)).toBe(source);
		expect(updates.at(-1)?.message).toEqual({
			role: "assistant",
			content: [{ type: "text", text: source }],
		});
		expect(updates.slice(0, -1).every((record) => record.message === null)).toBe(true);
		expect(Buffer.byteLength(chunks.join(""))).toBeLessThan(cumulativeBytes / 20);
	});

	it("latest-wins coalesces tool progress independently by toolCallId", async () => {
		const chunks: string[] = [];
		const scheduled: Array<() => void> = [];
		const writer = new SessionEventWriter(
			(chunk) => chunks.push(chunk),
			(flush) => scheduled.push(flush),
		);

		writer.enqueue("a", { type: "tool_execution_start", toolCallId: "A" });
		writer.enqueue("a", { type: "tool_execution_update", toolCallId: "A", partialResult: "A1" });
		writer.enqueue("a", { type: "tool_execution_update", toolCallId: "B", partialResult: "B1" });
		writer.enqueue("a", { type: "tool_execution_update", toolCallId: "A", partialResult: "A2" });
		writer.enqueue("a", { type: "tool_execution_update", toolCallId: "B", partialResult: "B2" });
		writer.enqueue("a", { type: "tool_execution_end", toolCallId: "A" });
		await scheduled[0]!();

		expect(
			records(chunks).map(({ type, toolCallId, partialResult }) => ({ type, toolCallId, partialResult })),
		).toEqual([
			{ type: "tool_execution_start", toolCallId: "A", partialResult: undefined },
			{ type: "tool_execution_update", toolCallId: "A", partialResult: "A2" },
			{ type: "tool_execution_update", toolCallId: "B", partialResult: "B2" },
			{ type: "tool_execution_end", toolCallId: "A", partialResult: undefined },
		]);
	});

	it("does not merge across assistant or protocol barriers", async () => {
		const chunks: string[] = [];
		const scheduled: Array<() => void> = [];
		const writer = new SessionEventWriter(
			(chunk) => chunks.push(chunk),
			(flush) => scheduled.push(flush),
		);

		writer.enqueue("a", cumulativeTextUpdate("a", "a"));
		writer.enqueue("a", cumulativeTextUpdate("b", "ab"));
		writer.enqueue("a", {
			type: "message_update",
			assistantMessageEvent: { type: "text_end", contentIndex: 0 },
			message: {},
		});
		writer.enqueue("a", cumulativeTextUpdate("c", "abc"));
		writer.enqueue("a", cumulativeTextUpdate("d", "abcd"));
		writer.enqueue("a", { type: "extension_ui_request", id: "ui" });
		writer.enqueue("a", cumulativeTextUpdate("e", "abcde"));
		writer.enqueue("a", cumulativeTextUpdate("f", "abcdef"));
		writer.enqueue("a", { type: "response", id: "command", success: true });
		writer.enqueue("a", cumulativeTextUpdate("g", "abcdefg"));
		writer.enqueue("a", cumulativeTextUpdate("h", "abcdefgh"));
		await scheduled[0]!();

		const output = records(chunks);
		expect(output.map((record) => record.type)).toEqual([
			"message_update",
			"message_update",
			"message_update",
			"message_update",
			"message_update",
			"extension_ui_request",
			"message_update",
			"message_update",
			"response",
			"message_update",
			"message_update",
		]);
		expect(flushedDeltas(output)).toBe("abcdefgh");
		expect(
			output
				.filter((record) => record.type === "message_update")
				.map((record) => (record.assistantMessageEvent as { type: string }).type),
		).toEqual([
			"text_delta",
			"text_delta",
			"text_end",
			"text_delta",
			"text_delta",
			"text_delta",
			"text_delta",
			"text_delta",
			"text_delta",
		]);
	});

	it("never coalesces delta-only, error, lifecycle, or unknown records", async () => {
		const chunks: string[] = [];
		const scheduled: Array<() => void> = [];
		const writer = new SessionEventWriter(
			(chunk) => chunks.push(chunk),
			(flush) => scheduled.push(flush),
		);
		const barriers = [
			{
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "delta-only" },
			},
			{ type: "extension_error", error: "boom" },
			{ type: "agent_settled" },
			{ type: "future_record", value: 1 },
		];

		barriers.forEach((barrier, index) => {
			const sessionId = `barrier-${index}`;
			writer.enqueue(sessionId, cumulativeTextUpdate("x", "x"));
			writer.enqueue(sessionId, barrier);
			writer.enqueue(sessionId, cumulativeTextUpdate("y", "xy"));
		});
		await scheduled[0]!();

		const output = records(chunks);
		expect(output).toHaveLength(12);
		expect(output.filter((record) => record.message === null)).toHaveLength(0);
		expect(output.filter((record) => record.type === "message_update")).toHaveLength(9);
	});

	it("tags every record, preserves per-session FIFO, and round-robins complete records", async () => {
		const chunks: string[] = [];
		const scheduled: Array<() => void> = [];
		const writer = new SessionEventWriter(
			(chunk) => chunks.push(chunk),
			(flush) => scheduled.push(flush),
		);

		writer.enqueue("a", { type: "message_update", sequence: 1 });
		writer.enqueue("a", { type: "tool_execution_update", payload: "x".repeat(128 * 1024) });
		writer.enqueue("b", { type: "message_update", sequence: 1 });
		writer.enqueue("a", { type: "agent_settled", sequence: 2 });
		writer.enqueue("b", { type: "agent_settled", sequence: 2 });
		await scheduled[0]!();

		expect(records(chunks)).toEqual([
			{ type: "message_update", sequence: 1, sessionId: "a" },
			{ type: "message_update", sequence: 1, sessionId: "b" },
			{ type: "tool_execution_update", payload: "x".repeat(128 * 1024), sessionId: "a" },
			{ type: "agent_settled", sequence: 2, sessionId: "b" },
			{ type: "agent_settled", sequence: 2, sessionId: "a" },
		]);
		// Each complete record is its own raw write: sessions are never coalesced.
		expect(chunks).toHaveLength(5);
	});

	it("does not let a gated socket stall a fast socket", async () => {
		const slowGate = deferred<void>();
		const slow: string[] = [];
		const fast: string[] = [];
		const writer = new SessionEventWriter(() => {});
		writer.registerConnection("slow", {
			writeRaw: (chunk) => slow.push(chunk),
			waitForBackpressure: () => slowGate.promise,
		});
		writer.registerConnection("fast", {
			writeRaw: (chunk) => fast.push(chunk),
			waitForBackpressure: async () => {},
		});

		writer.enqueue("session", { type: "event", sequence: 1 });
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		expect(slow).toHaveLength(1);
		expect(fast).toHaveLength(1);
		slowGate.resolve();
		await writer.flush();
	});

	it("replays the session snapshot when a socket attaches mid-stream", async () => {
		const first: string[] = [];
		const second: string[] = [];
		const writer = new SessionEventWriter(() => {});
		writer.registerConnection("first", {
			writeRaw: (chunk) => first.push(chunk),
			waitForBackpressure: async () => {},
		});
		writer.enqueue("session", { type: "message_start", message: { role: "assistant", content: [] } });
		writer.enqueue("session", {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "one" },
			message: null,
		});
		await writer.flush();
		writer.registerConnection("second", {
			writeRaw: (chunk) => second.push(chunk),
			waitForBackpressure: async () => {},
		});
		writer.enqueue("session", {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "two" },
			message: null,
		});
		await writer.flush();
		expect(
			records(second).map((record) => (record.assistantMessageEvent as { delta?: string })?.delta ?? record.type),
		).toEqual(["message_start", "one", "two"]);
	});

	it("routes extension UI responses only to that session's pending map and rejects pending work on close", () => {
		const a = new SessionExtensionUiRequests();
		const b = new SessionExtensionUiRequests();
		let resolvedA = false;
		let resolvedB = false;
		let rejectedA = false;
		a.set("request", { resolve: () => (resolvedA = true), reject: () => (rejectedA = true) });
		b.set("request", { resolve: () => (resolvedB = true), reject: () => {} });

		expect(a.resolve({ type: "extension_ui_response", id: "request", value: "A" })).toBe(true);
		expect(resolvedA).toBe(true);
		expect(resolvedB).toBe(false);
		a.set("closing", { resolve: () => {}, reject: () => (rejectedA = true) });
		a.close();
		expect(rejectedA).toBe(true);
		expect(a.resolve({ type: "extension_ui_response", id: "closing", value: "late" })).toBe(false);
		expect(b.resolve({ type: "extension_ui_response", id: "request", value: "B" })).toBe(true);
		expect(resolvedB).toBe(true);
	});

	it("broadcasts unsolicited extension UI state while targeting dialog requests", async () => {
		const chunks: string[] = [];
		const scheduled: Array<() => void> = [];
		const writer = new SessionEventWriter(
			(chunk) => chunks.push(chunk),
			(flush) => scheduled.push(flush),
		);
		writer.registerConnection("a", { writeRaw: (chunk) => chunks.push(chunk), waitForBackpressure: async () => {} });
		writer.registerConnection("b", { writeRaw: (chunk) => chunks.push(chunk), waitForBackpressure: async () => {} });
		writer.withConnection("a", () =>
			writer.enqueue("session", { type: "extension_ui_request", id: "dialog", method: "confirm" }),
		);
		writer.withConnection("a", () =>
			writer.enqueue("session", { type: "extension_ui_request", id: "status", method: "setStatus" }),
		);
		await scheduled[0]!();
		const output = records(chunks);
		expect(output.filter((record) => record.id === "dialog")).toHaveLength(1);
		expect(output.filter((record) => record.id === "status")).toHaveLength(2);
	});

	it("cancels all pending extension UI requests with matching ids", () => {
		const requests = new SessionExtensionUiRequests();
		const cancelled: string[] = [];
		requests.set("one", {
			resolve: (response) => {
				if ("cancelled" in response) cancelled.push(response.id);
			},
			reject: () => {},
		});
		requests.set("two", {
			resolve: (response) => {
				if ("cancelled" in response) cancelled.push(response.id);
			},
			reject: () => {},
		});
		requests.cancelAll();
		expect(cancelled).toEqual(["one", "two"]);
	});

	it("does not emit after a session is sealed, while allowing its terminal close response", async () => {
		const chunks: string[] = [];
		const writer = new SessionEventWriter(
			(chunk) => chunks.push(chunk),
			(flush) => flush(),
		);

		writer.enqueue("a", { type: "message_update" });
		writer.closeSession("a", { id: "close-a", type: "response", command: "close_session", success: true });
		writer.enqueue("a", { type: "agent_settled" });
		writer.enqueue("b", { type: "agent_settled" });
		await writer.flush();

		expect(records(chunks)).toEqual([
			{ type: "message_update", sessionId: "a" },
			{ id: "close-a", type: "response", command: "close_session", success: true, sessionId: "a" },
			{ type: "agent_settled", sessionId: "b" },
		]);
	});

	it("keeps one raw write in flight while round-robining ready sessions", async () => {
		const chunks: string[] = [];
		const scheduled: Array<() => Promise<void>> = [];
		const releases = [deferred(), deferred(), deferred()];
		const writes = [deferred(), deferred(), deferred()];
		let writeIndex = 0;
		let waitIndex = 0;
		const writer = new SessionEventWriter(
			(chunk) => {
				chunks.push(chunk);
				writes[writeIndex++]?.resolve();
			},
			() => releases[waitIndex++]!.promise,
			(flush) => scheduled.push(flush),
		);

		writer.enqueue("a", { type: "event", sequence: "A1" });
		const draining = scheduled[0]!();
		await writes[0]!.promise;
		writer.enqueue("a", { type: "event", sequence: "A2" });
		writer.enqueue("b", { type: "event", sequence: "B1" });
		expect(chunks).toHaveLength(1);
		expect(writer.bufferedRecordCount).toBe(3);

		releases[0]!.resolve();
		await writes[1]!.promise;
		expect(records(chunks).map((record) => record.sequence)).toEqual(["A1", "B1"]);
		expect(chunks).toHaveLength(2);

		releases[1]!.resolve();
		await writes[2]!.promise;
		expect(records(chunks).map((record) => record.sequence)).toEqual(["A1", "B1", "A2"]);
		releases[2]!.resolve();
		await draining;
		expect(writer.bufferedRecordCount).toBe(0);
		expect(writer.bufferedByteLength).toBe(0);
	});

	it("never drops or coalesces untagged control responses", async () => {
		const chunks: string[] = [];
		const scheduled: Array<() => Promise<void>> = [];
		const writer = new SessionEventWriter(
			(chunk) => chunks.push(chunk),
			async () => {},
			(flush) => scheduled.push(flush),
		);

		writer.enqueue("a", { type: "event", sequence: 1 });
		const first = writer.enqueueControl({ type: "response", id: "control-1", success: true });
		writer.enqueue("a", { type: "event", sequence: 2 });
		const second = writer.enqueueControl({ type: "response", id: "control-2", success: false });
		await scheduled[0]!();
		await Promise.all([first, second]);

		expect(records(chunks)).toEqual([
			{ type: "event", sequence: 1, sessionId: "a" },
			{ type: "response", id: "control-1", success: true },
			{ type: "event", sequence: 2, sessionId: "a" },
			{ type: "response", id: "control-2", success: false },
		]);
		expect(chunks).toHaveLength(4);
	});

	it("flush waits for the in-flight record and all retained records", async () => {
		const chunks: string[] = [];
		const releases = [deferred(), deferred()];
		const writes = [deferred(), deferred()];
		let writeIndex = 0;
		let waitIndex = 0;
		const writer = new SessionEventWriter(
			(chunk) => {
				chunks.push(chunk);
				writes[writeIndex++]?.resolve();
			},
			() => releases[waitIndex++]!.promise,
		);
		writer.enqueue("a", { type: "event", sequence: 1 });
		writer.enqueue("a", { type: "event", sequence: 2 });

		let flushed = false;
		const flush = writer.flush().then(() => {
			flushed = true;
		});
		await writes[0]!.promise;
		expect(flushed).toBe(false);
		expect(writer.bufferedRecordCount).toBe(2);
		expect(writer.bufferedByteLength).toBeGreaterThan(0);

		releases[0]!.resolve();
		await writes[1]!.promise;
		expect(flushed).toBe(false);
		releases[1]!.resolve();
		await flush;
		expect(flushed).toBe(true);
		expect(records(chunks).map((record) => record.sequence)).toEqual([1, 2]);
	});

	it("seals close_session after the retained stream and rejects late enqueue", async () => {
		const chunks: string[] = [];
		const scheduled: Array<() => Promise<void>> = [];
		const writer = new SessionEventWriter(
			(chunk) => chunks.push(chunk),
			async () => {},
			(flush) => scheduled.push(flush),
		);

		writer.enqueue("a", cumulativeTextUpdate("a", "a"));
		writer.enqueue("a", cumulativeTextUpdate("b", "ab"));
		writer.closeSession("a", { id: "close-a", type: "response", command: "close_session", success: true });
		expect(writer.enqueue("a", cumulativeTextUpdate("late", "ablate"))).toBe(false);
		await scheduled[0]!();

		const output = records(chunks);
		expect(flushedDeltas(output)).toBe("ab");
		expect(output.at(-1)).toEqual({
			id: "close-a",
			type: "response",
			command: "close_session",
			success: true,
			sessionId: "a",
		});
	});

	it("rejects flush and control completion on permanent stdout errors", async () => {
		const failure = new Error("EPIPE: permanent stdout failure");
		const writer = new SessionEventWriter(
			() => {},
			async () => {
				throw failure;
			},
		);
		writer.enqueue("a", { type: "event" });
		const control = writer.enqueueControl({ type: "response", id: "control" });

		await expect(writer.flush()).rejects.toBe(failure);
		await expect(control).rejects.toBe(failure);
		await expect(writer.flush()).rejects.toBe(failure);
	});
});
