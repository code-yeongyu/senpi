import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { ControlAttachments } from "../../../src/modes/interactive/session-control-attach.ts";
import { RpcClient } from "../../../src/modes/rpc/rpc-client.ts";
import { SessionEventFanout } from "../../../src/modes/rpc/session-event-fanout.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { createRpcEventOutputBuffer } from "../../../src/modes/rpc/event-output-buffer.ts";
import { createHarness } from "../harness.ts";

const COUNT = 2000;
const DELTA = "x".repeat(32);

function update(index: number) {
	const message = fauxAssistantMessage(DELTA.repeat(index), { timestamp: 1 });
	return {
		type: "message_update" as const,
		message,
		usage: message.usage,
		assistantMessageEvent: { type: "text_delta" as const, contentIndex: 0, delta: DELTA, partial: message },
	};
}

function linesOf(fanout: SessionEventFanout): string[] {
	const snapshots = Reflect.get(fanout, "sessionSnapshots") as Map<string, Array<{ line: string }>>;
	return (snapshots.get("s") ?? []).map((record) => record.line);
}

function expectLinear(lines: string[], count = COUNT): void {
	const snapshots = lines.map((line) => JSON.parse(line) as ReturnType<typeof update>);
	expect(
		snapshots.filter((record) => record.type === "message_update" && record.assistantMessageEvent.partial),
	).toHaveLength(1);
	expect(lines.reduce((bytes, line) => bytes + Buffer.byteLength(line), 0)).toBeLessThan(
		count * (1024 + DELTA.length * 4),
	);
	expect(JSON.stringify(snapshots.at(-1)?.assistantMessageEvent.partial)).toBe(JSON.stringify(update(count).message));
}

describe("in-flight partial retention (omo#11824, part of senpi#2929)", () => {
	it("bounds classic same-tick output without dropping deltas", () => {
		const chunks: string[] = [];
		const buffer = createRpcEventOutputBuffer(
			(chunk) => chunks.push(chunk),
			() => {},
		);
		for (let index = 1; index <= COUNT; index++) buffer.enqueueEvent(update(index));
		buffer.flushEvents();
		expectLinear(chunks.join("").trimEnd().split("\n"));
	});
	it("bounds the host replay store and preserves every delta", () => {
		const writer = new SessionEventWriter(
			() => {},
			() => {},
		);
		writer.registerConnection("host", { writeRaw: () => {}, waitForBackpressure: async () => {} });
		const fanout: SessionEventFanout = Reflect.get(writer, "fanout");
		writer.enqueue("s", { type: "message_start", message: fauxAssistantMessage("", { timestamp: 1 }) });
		for (let index = 1; index <= COUNT; index++) writer.enqueue("s", update(index));
		const lines = linesOf(fanout);
		expectLinear(lines);
		expect(
			lines
				.slice(1)
				.map((line) => JSON.parse(line).assistantMessageEvent.delta)
				.join(""),
		).toBe(DELTA.repeat(COUNT));
		writer.enqueue("s", { type: "message_end", message: update(COUNT).message });
		expect(linesOf(fanout)).toEqual([]);
		writer.unregisterConnection("host");
	});

	it("bounds the real ControlAttachments idle replay feed with no attached clients", async () => {
		const harness = await createHarness();
		const subscribe = vi.spyOn(harness.session, "subscribe").mockImplementation(() => () => {});
		const attachments = new ControlAttachments(harness.session, () => 0);
		const emit = subscribe.mock.calls[0]?.[0];
		const fanout: SessionEventFanout = Reflect.get(attachments.writer, "fanout");
		try {
			emit?.({ type: "message_start", message: fauxAssistantMessage("", { timestamp: 1 }) });
			for (let index = 1; index <= COUNT; index++) emit?.(update(index));
			const snapshots = Reflect.get(fanout, "sessionSnapshots") as Map<string, Array<{ line: string }>>;
			expectLinear((snapshots.get(harness.session.sessionId) ?? []).map((record) => record.line));
		} finally {
			attachments.dispose();
			subscribe.mockRestore();
			harness.cleanup();
		}
	});

	it.each(["stdio", "socket"] as const)("demotes %s queued snapshots across ordering barriers", async (mode) => {
		const drain = Promise.withResolvers<void>();
		const writer = new SessionEventWriter(
			() => {},
			() => {},
		);
		if (mode === "socket") {
			writer.registerConnection("peer", { writeRaw: () => {}, waitForBackpressure: () => drain.promise });
			writer.attachConnectionToSession("peer", "s");
			writer.enqueue("s", { type: "probe" });
		}
		try {
			for (let index = 1; index <= 100; index++) {
				const value = update(index);
				writer.enqueue(
					"s",
					index % 2 === 0
						? {
								...value,
								assistantMessageEvent: { type: "thinking_start", contentIndex: 1, partial: value.message },
							}
						: value,
				);
				writer.enqueue("s", { type: "extension_event", name: "barrier", data: index });
			}
			const retained: string[] = [];
			if (mode === "socket") {
				const fanout: SessionEventFanout = Reflect.get(writer, "fanout");
				const actor = fanout.get("peer")?.actor;
				if (!actor) throw new Error("the socket peer was not registered");
				const queue = Reflect.get(actor, "queue") as Array<{ line: string }>;
				retained.push(...queue.map((record) => record.line));
			} else {
				const queues = Reflect.get(writer, "queues") as Map<
					string,
					{
						head?: { line: string; next?: unknown };
					}
				>;
				for (const queue of queues.values()) {
					let node = queue.head;
					while (node) {
						retained.push(node.line);
						node = node.next as typeof node;
					}
				}
			}
			const updates = retained.filter((line) => JSON.parse(line).type === "message_update");
			expectLinear(updates, 100);
			expect(retained.filter((line) => JSON.parse(line).type === "extension_event")).toHaveLength(100);
		} finally {
			drain.resolve();
			await writer.flush();
			writer.unregisterConnection("peer");
		}
	});

	it("replays the exact current partial to a late attachment and recovery", async () => {
		const writer = new SessionEventWriter(() => {});
		const fanout: SessionEventFanout = Reflect.get(writer, "fanout");
		let live: ReturnType<typeof update> | undefined;
		writer.registerConnection("live", {
			writeRaw: (line) => {
				const record = JSON.parse(line);
				if (record.type === "message_update") live = record;
			},
			waitForBackpressure: async () => {},
		});
		writer.attachConnectionToSession("live", "s");
		writer.enqueue("s", { type: "message_start", message: fauxAssistantMessage("", { timestamp: 1 }) });
		for (let index = 1; index <= COUNT; index++) writer.enqueue("s", update(index));
		await writer.flushConnection("live");
		const replay: string[] = [];
		fanout.registerConnection("late", { writeRaw: (line) => replay.push(line), waitForBackpressure: async () => {} });
		fanout.attachConnectionToSession("late", "s");
		await fanout.get("late")?.actor.flush();
		expectLinear(replay);
		const current = JSON.parse(replay.at(-1) ?? "");
		expect(JSON.stringify(current.message)).toBe(JSON.stringify(live?.message));
		const resync = Reflect.get(fanout, "resyncSnapshot").call(fanout, "late", "overflow", ["s"]);
		expect(JSON.stringify(resync[0].message)).toBe(JSON.stringify(live?.message));
		fanout.forgetSession("s");
		expect(linesOf(fanout)).toEqual([]);
		fanout.unregisterConnection("late");
		writer.unregisterConnection("live");
	});

	it.each(["message_end", "agent_end", "session_abort"] as const)("releases replay on %s", (type) => {
		const fanout = new SessionEventFanout();
		const start = { type: "message_start", message: update(1).message };
		fanout.rememberSnapshot("s", start, JSON.stringify(start));
		const partial = update(2);
		fanout.rememberSnapshot("s", partial, JSON.stringify(partial));
		fanout.rememberSnapshot("s", { type }, JSON.stringify({ type }));
		expect(linesOf(fanout)).toEqual([]);
		expect((Reflect.get(fanout, "latestPartials") as Map<string, unknown>).size).toBe(0);
	});

	it("keeps tool-call identity when a replayed start loses its partial", () => {
		const fanout = new SessionEventFanout();
		const message = {
			...update(1).message,
			content: [{ type: "toolCall", id: "call", name: "eval", arguments: {} }],
		};
		const start = { type: "message_start", message };
		fanout.rememberSnapshot("s", start, JSON.stringify(start));
		const tool = {
			type: "message_update",
			message,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: message },
		};
		fanout.rememberSnapshot("s", tool, JSON.stringify(tool));
		fanout.rememberSnapshot("s", update(2), JSON.stringify(update(2)));
		expect(JSON.parse(linesOf(fanout)[1] ?? "").assistantMessageEvent).toEqual({
			type: "toolcall_start",
			contentIndex: 0,
			partial: null,
			id: "call",
			toolName: "eval",
		});
	});

	it("bounds RpcClient.collectEvents without changing live event delivery", async () => {
		const client = new RpcClient();
		let live = 0;
		client.onEvent((event) => {
			if (event.type === "message_update") {
				expect(Reflect.get(event.assistantMessageEvent, "partial")).toBeDefined();
				live++;
			}
		});
		const collected = client.collectEvents();
		const handle = Reflect.get(client, "handleLine").bind(client) as (line: string) => void;
		for (let index = 1; index <= COUNT; index++) handle(JSON.stringify(update(index)));
		handle('{"type":"agent_settled"}');
		const records = await collected;
		expect(live).toBe(COUNT);
		expectLinear(records.slice(0, -1).map((record) => JSON.stringify(record)));
		expect(records.at(-1)?.type).toBe("agent_settled");
	});

	it("demotes pending-open snapshots before the startup byte budget evicts deltas", () => {
		const client = new RpcClient();
		Reflect.set(client, "pendingOpenSession", true);
		const handle = Reflect.get(client, "handleLine").bind(client) as (line: string) => void;
		for (let index = 1; index <= 100; index++) handle(JSON.stringify({ ...update(index), sessionId: "s" }));
		const pending = Reflect.get(client, "pendingSessionEvents") as Array<{ event: object; bytes: number }>;
		expect(pending).toHaveLength(100);
		expectLinear(
			pending.map(({ event }) => JSON.stringify(event)),
			100,
		);
		expect(Reflect.get(client, "pendingSessionEventBytes")).toBe(
			pending.reduce((sum, entry) => sum + entry.bytes, 0),
		);
	});
});
