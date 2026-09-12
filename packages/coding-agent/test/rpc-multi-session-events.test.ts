import { describe, expect, it } from "vitest";
import { MEDIA_PLACEHOLDERS_CAPABILITY } from "../src/modes/rpc/custom-capability.ts";
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

function widgetLines(record: Record<string, unknown>): string[] | undefined {
	const lines = record.widgetLines;
	return Array.isArray(lines) && lines.every((line): line is string => typeof line === "string") ? lines : undefined;
}

function flushedDeltas(output: readonly Record<string, unknown>[]): string {
	return output
		.filter((record) => record.type === "message_update")
		.map((record) => (record.assistantMessageEvent as { delta?: string }).delta ?? "")
		.join("");
}

const SNAPSHOT_IMAGE_BASE64 = "aGVsbG8gd29ybGQh"; // 16 chars -> 12 bytes decoded

function toolResultEnd(): Record<string, unknown> {
	return {
		type: "tool_execution_end",
		toolCallId: "call_abc",
		toolName: "read",
		result: {
			content: [
				{ type: "text", text: "read image" },
				{ type: "image", data: SNAPSHOT_IMAGE_BASE64, mimeType: "image/png" },
			],
		},
	};
}

function imageBlock(chunks: readonly string[]): Record<string, unknown> | undefined {
	const record = records(chunks).find((parsed) => parsed.type === "tool_execution_end");
	const content = (record?.result as { content?: Array<Record<string, unknown>> } | undefined)?.content;
	return content?.[1];
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

	it("delivers session agent events only to attached connections", async () => {
		const a: string[] = [];
		const b: string[] = [];
		const unattached: string[] = [];
		const writer = new SessionEventWriter(() => {});
		writer.registerConnection("a", { writeRaw: (chunk) => a.push(chunk), waitForBackpressure: async () => {} });
		writer.registerConnection("b", { writeRaw: (chunk) => b.push(chunk), waitForBackpressure: async () => {} });
		writer.registerConnection("unattached", {
			writeRaw: (chunk) => unattached.push(chunk),
			waitForBackpressure: async () => {},
		});
		writer.attachConnectionToSession("a", "s1");
		writer.attachConnectionToSession("b", "s2");

		writer.enqueue("s1", { type: "message_update", message: "s1" });
		await writer.flush();

		expect(records(a)).toHaveLength(1);
		expect(records(a)[0]).toMatchObject({ sessionId: "s1", message: "s1" });
		expect(records(b)).toEqual([]);
		expect(records(unattached)).toEqual([]);
	});

	it("broadcasts content-free lifecycle records to unattached connections only", async () => {
		const attached: string[] = [];
		const unattached: string[] = [];
		const writer = new SessionEventWriter(() => {});
		writer.registerConnection("attached", {
			writeRaw: (chunk) => attached.push(chunk),
			waitForBackpressure: async () => {},
		});
		writer.registerConnection("unattached", {
			writeRaw: (chunk) => unattached.push(chunk),
			waitForBackpressure: async () => {},
		});
		writer.attachConnectionToSession("attached", "session");

		for (const type of ["agent_start", "agent_settled", "agent_idle", "session_opened", "session_closed"])
			writer.enqueue("session", { type });
		writer.enqueue("session", { type: "message_update", message: "private" });
		await writer.flush();

		expect(records(unattached).map((record) => record.type)).toEqual([
			"agent_start",
			"agent_settled",
			"agent_idle",
			"session_opened",
			"session_closed",
		]);
		expect(records(unattached).every((record) => record.sessionId === "session")).toBe(true);
		expect(records(attached).map((record) => record.type)).toEqual([
			"agent_start",
			"agent_settled",
			"agent_idle",
			"session_opened",
			"session_closed",
			"message_update",
		]);
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
		writer.attachConnectionToSession("slow", "session");
		writer.attachConnectionToSession("fast", "session");

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
		writer.attachConnectionToSession("first", "session");
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
		writer.attachConnectionToSession("second", "session");
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

	it("does not replay targeted records to a connection attaching mid-turn", async () => {
		const first: string[] = [];
		const second: string[] = [];
		const writer = new SessionEventWriter(() => {});
		writer.registerConnection("first", {
			writeRaw: (chunk) => first.push(chunk),
			waitForBackpressure: async () => {},
		});
		writer.attachConnectionToSession("first", "session");
		writer.enqueue("session", { type: "message_start" });
		writer.withConnection("first", () => writer.enqueue("session", { type: "response", id: "private-response" }));
		writer.withConnection("first", () =>
			writer.enqueue("session", { type: "extension_ui_request", id: "private-dialog", method: "confirm" }),
		);
		writer.registerConnection("second", {
			writeRaw: (chunk) => second.push(chunk),
			waitForBackpressure: async () => {},
		});
		writer.attachConnectionToSession("second", "session");
		await writer.flush();

		expect(records(second)).toEqual([{ type: "message_start", sessionId: "session" }]);
		expect(records(first).some((record) => record.id === "private-response")).toBe(true);
		expect(records(first).some((record) => record.id === "private-dialog")).toBe(true);
	});

	it("replays an attaching connection only once when attach is repeated", async () => {
		const output: string[] = [];
		const writer = new SessionEventWriter(() => {});
		writer.registerConnection("client", {
			writeRaw: (chunk) => output.push(chunk),
			waitForBackpressure: async () => {},
		});
		writer.enqueue("session", { type: "message_start" });
		writer.enqueue("session", { type: "message_update", sequence: 1 });
		writer.attachConnectionToSession("client", "session");
		writer.attachConnectionToSession("client", "session");
		await writer.flush();

		expect(records(output)).toEqual([
			{ type: "message_start", sessionId: "session" },
			{ type: "message_update", sequence: 1, sessionId: "session" },
		]);
	});

	it("filters rendered snapshot replay by each connection capability", async () => {
		const capable: string[] = [];
		const defaultClient: string[] = [];
		const lateCapable: string[] = [];
		const writer = new SessionEventWriter(() => {});
		writer.registerConnection("capable", {
			writeRaw: (chunk) => capable.push(chunk),
			waitForBackpressure: async () => {},
		});
		writer.setConnectionCapabilities("capable", ["rendered_components"]);
		writer.attachConnectionToSession("capable", "session");
		writer.enqueue("session", { type: "message_start" });
		writer.enqueue("session", {
			type: "extension_ui_request",
			method: "setWidget",
			widgetLines: ["factory"],
			__senpiRenderedComponent: true,
		});
		writer.enqueue("session", { type: "extension_ui_request", method: "setWidget", widgetLines: ["array"] });
		await writer.flush();

		writer.registerConnection("default", {
			writeRaw: (chunk) => defaultClient.push(chunk),
			waitForBackpressure: async () => {},
		});
		writer.attachConnectionToSession("default", "session");
		writer.registerConnection("late-capable", {
			writeRaw: (chunk) => lateCapable.push(chunk),
			waitForBackpressure: async () => {},
		});
		writer.setConnectionCapabilities("late-capable", ["rendered_components"]);
		writer.attachConnectionToSession("late-capable", "session");
		await writer.flush();

		expect(records(defaultClient).some((record) => widgetLines(record)?.includes("factory"))).toBe(false);
		expect(records(defaultClient).some((record) => widgetLines(record)?.includes("array"))).toBe(true);
		expect(records(lateCapable).some((record) => widgetLines(record)?.includes("factory"))).toBe(true);
	});

	it("scopes rendered delivery and capability presence to the attached session", async () => {
		const a: string[] = [];
		const b: string[] = [];
		const writer = new SessionEventWriter(() => {});
		writer.registerConnection("a", { writeRaw: (chunk) => a.push(chunk), waitForBackpressure: async () => {} });
		writer.registerConnection("b", { writeRaw: (chunk) => b.push(chunk), waitForBackpressure: async () => {} });
		writer.setConnectionCapabilities("a", ["rendered_components"]);
		writer.attachConnectionToSession("a", "session-a");
		writer.attachConnectionToSession("b", "session-b");
		expect(writer.hasCapableConnection("session-a")).toBe(true);
		expect(writer.hasCapableConnection("session-b")).toBe(false);
		writer.enqueue("session-a", { type: "extension_ui_request", widgetLines: ["a"], __senpiRenderedComponent: true });
		writer.enqueue("session-b", { type: "extension_ui_request", widgetLines: ["b"], __senpiRenderedComponent: true });
		await writer.flush();
		expect(records(a).some((record) => widgetLines(record)?.includes("a"))).toBe(true);
		expect(records(a).some((record) => widgetLines(record)?.includes("b"))).toBe(false);
		expect(records(b).some((record) => widgetLines(record)?.includes("b"))).toBe(false);
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

	it("delivers rendered component records only to registered capable connections", async () => {
		const a: string[] = [];
		const b: string[] = [];
		const writer = new SessionEventWriter(() => {});
		writer.registerConnection("a", { writeRaw: (chunk) => a.push(chunk), waitForBackpressure: async () => {} });
		writer.registerConnection("b", { writeRaw: (chunk) => b.push(chunk), waitForBackpressure: async () => {} });
		writer.setConnectionCapabilities("a", ["rendered_components"]);
		writer.attachConnectionToSession("a", "session");
		writer.attachConnectionToSession("b", "session");
		writer.enqueue("session", {
			type: "extension_ui_request",
			method: "setWidget",
			widgetLines: ["factory"],
			__senpiRenderedComponent: true,
		});
		writer.enqueue("session", { type: "extension_ui_request", method: "setWidget", widgetLines: ["array"] });
		await writer.flush();
		expect(records(a).filter((record) => record.widgetLines)).toHaveLength(2);
		expect(records(b).filter((record) => record.widgetLines)).toEqual([
			{ type: "extension_ui_request", method: "setWidget", widgetLines: ["array"], sessionId: "session" },
		]);
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
		writer.attachConnectionToSession("a", "session");
		writer.attachConnectionToSession("b", "session");
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
			{ type: "session_closed", sessionId: "a" },
			{ type: "agent_settled", sessionId: "b" },
			{ id: "close-a", type: "response", command: "close_session", success: true, sessionId: "a" },
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

	it("replays the placeholder snapshot variant to a capable connection attaching mid-message", async () => {
		const first: string[] = [];
		const capable: string[] = [];
		const writer = new SessionEventWriter(() => {});
		writer.registerConnection("first", {
			writeRaw: (chunk) => first.push(chunk),
			waitForBackpressure: async () => {},
		});
		writer.attachConnectionToSession("first", "session");
		writer.enqueue("session", { type: "message_start", message: { role: "assistant", content: [] } });
		writer.enqueue("session", toolResultEnd());
		await writer.flush();

		// When: a media_placeholders client attaches mid-message.
		writer.registerConnection("capable", {
			writeRaw: (chunk) => capable.push(chunk),
			waitForBackpressure: async () => {},
		});
		writer.setConnectionCapabilities("capable", [MEDIA_PLACEHOLDERS_CAPABILITY]);
		writer.attachConnectionToSession("capable", "session");
		await writer.flush();

		// Then: the replayed snapshot carries placeholders, the live client kept the bytes.
		expect(imageBlock(capable)).toEqual({
			type: "image_ref",
			mimeType: "image/png",
			byteLength: 12,
			ref: { toolCallId: "call_abc", contentIndex: 1 },
		});
		expect(imageBlock(first)).toEqual({ type: "image", data: SNAPSHOT_IMAGE_BASE64, mimeType: "image/png" });
		expect(records(capable).map((record) => record.type)).toEqual(["message_start", "tool_execution_end"]);
	});

	it("does not retroactively replay when media_placeholders is advertised after attach", async () => {
		const late: string[] = [];
		const writer = new SessionEventWriter(() => {});
		writer.registerConnection("late", {
			writeRaw: (chunk) => late.push(chunk),
			waitForBackpressure: async () => {},
		});
		writer.attachConnectionToSession("late", "session");
		writer.enqueue("session", { type: "message_start", message: { role: "assistant", content: [] } });
		writer.enqueue("session", toolResultEnd());
		await writer.flush();

		// When: the connection flips the capability on after it already received the bytes.
		writer.setConnectionCapabilities("late", [MEDIA_PLACEHOLDERS_CAPABILITY]);
		await writer.flush();

		// Then: nothing is replayed; the earlier records stay as delivered.
		expect(records(late).map((record) => record.type)).toEqual(["message_start", "tool_execution_end"]);
		expect(imageBlock(late)).toEqual({ type: "image", data: SNAPSHOT_IMAGE_BASE64, mimeType: "image/png" });
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
