import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RpcClient, RpcTransportGoneError } from "../../src/modes/rpc/rpc-client.ts";

type Request = { type: string; id: string };

function fixture(handle: (request: Request, emit: (frame: unknown) => void) => void) {
	const client = new RpcClient();
	const stream = new PassThrough();
	Reflect.set(client, "socket", stream);
	const emit = (frame: unknown) => {
		const parse = Reflect.get(client, "handleLine") as (line: string) => void;
		parse.call(client, JSON.stringify(frame));
	};
	const requests: Request[] = [];
	stream.on("data", (data: Buffer) => {
		const request = JSON.parse(data.toString()) as Request;
		requests.push(request);
		handle(request, emit);
	});
	return {
		client,
		emit,
		requests,
		listeners: () => (Reflect.get(client, "eventListeners") as unknown[]).length,
		pending: () => (Reflect.get(client, "pendingRequests") as Map<string, unknown>).size,
	};
}

function state(request: Request, isStreaming: boolean, extra: Record<string, unknown> = {}) {
	return { type: "response", command: request.type, id: request.id, success: true, data: { isStreaming, ...extra } };
}

afterEach(() => vi.useRealTimers());

describe("RPC idle and event collection lifecycle", () => {
	test("returns for an already-idle session without waiting for a future settlement event", async () => {
		vi.useFakeTimers();
		const f = fixture((request, emit) => emit(state(request, false)));
		f.emit({ type: "agent_settled" });
		const outcome = f.client.waitForIdle(100).then(
			() => "idle",
			(error: Error) => error.message,
		);
		await vi.advanceTimersByTimeAsync(100);
		expect(await outcome).toBe("idle");
		expect(f.requests.map((request) => request.type)).toEqual(["get_state"]);
		expect(f.listeners()).toBe(0);
		expect(f.pending()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	test("matches local idle semantics even when independent compaction or queued metadata exists", async () => {
		vi.useFakeTimers();
		const f = fixture((request, emit) => emit(state(request, false, { isCompacting: true, pendingMessageCount: 1 })));
		const outcome = f.client.waitForIdle(100).then(
			() => "idle",
			() => "timeout",
		);
		await vi.advanceTimersByTimeAsync(100);
		expect(await outcome).toBe("idle");
	});

	test("keeps a busy run waiting across agent_end and finishes all concurrent waiters at settlement", async () => {
		vi.useFakeTimers();
		const f = fixture((request, emit) => emit(state(request, true, { retryAttempt: 1 })));
		const completed: number[] = [];
		const waits = [1, 2].map((id) => f.client.waitForIdle(100).then(() => completed.push(id)));
		f.emit({ type: "agent_end", messages: [] });
		await Promise.resolve();
		expect(completed).toEqual([]);
		f.emit({ type: "agent_settled" });
		const results = Promise.allSettled(waits);
		await vi.advanceTimersByTimeAsync(100);
		expect((await results).every((result) => result.status === "fulfilled")).toBe(true);
		expect(completed).toEqual([1, 2]);
		expect(f.listeners()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	test("catches settlement during the state query and cancels its unanswered request", async () => {
		vi.useFakeTimers();
		const f = fixture((_request, emit) => emit({ type: "agent_settled" }));
		const outcome = f.client.waitForIdle(100).then(
			() => "idle",
			() => "timeout",
		);
		await vi.advanceTimersByTimeAsync(100);
		expect(await outcome).toBe("idle");
		expect(f.pending()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	test("uses the authoritative snapshot in frame order before a subsequent run begins", async () => {
		vi.useFakeTimers();
		const f = fixture((request, emit) => {
			emit(state(request, false));
			emit({ type: "agent_start" });
		});
		const outcome = f.client.waitForIdle(100).then(
			() => "idle",
			() => "timeout",
		);
		await vi.advanceTimersByTimeAsync(100);
		expect(await outcome).toBe("idle");
		expect(f.pending()).toBe(0);
	});

	test("timeout removes both the event listener and the unanswered state request", async () => {
		vi.useFakeTimers();
		const f = fixture(() => undefined);
		const result = expect(f.client.waitForIdle(100)).rejects.toThrow("Timeout waiting for agent");
		await vi.advanceTimersByTimeAsync(100);
		await result;
		expect(f.pending()).toBe(0);
		expect(f.listeners()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	test("stop rejects event collectors and idle waiters without leaving timers", async () => {
		vi.useFakeTimers();
		const f = fixture((request, emit) => emit(state(request, true)));
		const idle = expect(f.client.waitForIdle()).rejects.toBeInstanceOf(RpcTransportGoneError);
		const collected = expect(f.client.collectEvents()).rejects.toBeInstanceOf(RpcTransportGoneError);
		const result = Promise.all([idle, collected]);
		await f.client.stop();
		await vi.advanceTimersByTimeAsync(60_000);
		await result;
		expect(f.pending()).toBe(0);
		expect(f.listeners()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	test("a refused prompt immediately removes its collector rather than rejecting it unobserved later", async () => {
		vi.useFakeTimers();
		const f = fixture((request, emit) =>
			emit({ type: "response", id: request.id, command: request.type, success: false, error: "preflight refused" }),
		);
		try {
			await expect(f.client.promptAndWait("hello", undefined, 100)).rejects.toThrow("preflight refused");
			expect(f.listeners()).toBe(0);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			// Also cleans up the defective baseline collector during RED reproduction.
			f.emit({ type: "agent_settled" });
		}
	});

	test("a refused state snapshot rejects the idle wait and removes its listener", async () => {
		vi.useFakeTimers();
		const f = fixture((request, emit) =>
			emit({ type: "response", id: request.id, command: request.type, success: false, error: "unknown session" }),
		);
		await expect(f.client.waitForIdle()).rejects.toThrow("unknown session");
		expect(f.listeners()).toBe(0);
		expect(f.pending()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	test("an unanswered state request cleans up the longer idle waiter at its request deadline", async () => {
		vi.useFakeTimers();
		const f = fixture(() => undefined);
		const result = expect(f.client.waitForIdle()).rejects.toThrow("Timeout waiting for response to get_state");
		await vi.advanceTimersByTimeAsync(30_000);
		await result;
		expect(f.listeners()).toBe(0);
		expect(f.pending()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	test("collection timeout removes its listener", async () => {
		vi.useFakeTimers();
		const f = fixture(() => undefined);
		const result = expect(f.client.collectEvents(100)).rejects.toThrow("Timeout collecting events");
		await vi.advanceTimersByTimeAsync(100);
		await result;
		expect(f.listeners()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	test("stop also rejects a collector created before starting the client", async () => {
		vi.useFakeTimers();
		const client = new RpcClient();
		const result = expect(client.collectEvents()).rejects.toBeInstanceOf(RpcTransportGoneError);
		await client.stop();
		await result;
		expect(vi.getTimerCount()).toBe(0);
	});

	// senpi#2209: an acknowledged open and an owned idle query have independent deadlines.
	test("keeps an acknowledged open alive when an idle query cancels and excludes queued records", async () => {
		vi.useFakeTimers();
		const f = fixture(() => undefined);
		const collected = f.client.collectEvents(120_000);
		const open = f.client.openSession({ cwd: "/tmp" });
		const opening = f.requests[0];
		f.emit({ type: "queued", for_request: opening.id, position: 1, in_flight: 0 });
		const idle = expect(f.client.waitForIdle(100)).rejects.toThrow("Timeout waiting for agent");
		await vi.advanceTimersByTimeAsync(100);
		await idle;
		expect(f.pending()).toBe(1);
		await vi.advanceTimersByTimeAsync(57_000);
		f.emit({
			type: "response",
			id: opening.id,
			command: "open_session",
			success: true,
			data: { sessionId: "owned", state: {} },
		});
		await expect(open).resolves.toMatchObject({ sessionId: "owned" });
		f.emit({ type: "agent_settled", sessionId: "owned" });
		expect((await collected).map((event) => event.type)).toEqual(["agent_settled"]);
		expect(f.pending()).toBe(0);
		expect(f.listeners()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	test("delivers buffered settlement to every concurrent collector during lease acquisition", async () => {
		vi.useFakeTimers();
		const f = fixture(() => undefined);
		Reflect.set(f.client, "pendingOpenSession", true);
		f.emit({ type: "agent_settled", sessionId: "owned" });
		const results = Promise.all([f.client.collectEvents(), f.client.collectEvents()]);
		Reflect.set(f.client, "sessionId", "owned");
		(Reflect.get(f.client, "flushPendingSessionEvents") as () => void).call(f.client);
		expect((await results).map((events) => events.map((event) => event.type))).toEqual([
			["agent_settled"],
			["agent_settled"],
		]);
		expect(f.listeners()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	test("drops a late cancelled state response instead of publishing it as an agent event", async () => {
		vi.useFakeTimers();
		const f = fixture(() => undefined);
		const idle = f.client.waitForIdle();
		f.emit({ type: "agent_settled" });
		await idle;
		const collected = f.client.collectEvents();
		f.emit(state(f.requests[0], true));
		f.emit({ type: "agent_settled" });
		expect((await collected).map((event) => event.type)).toEqual(["agent_settled"]);
		expect(vi.getTimerCount()).toBe(0);
	});

	test("a throwing response callback rejects its prompt and cleans up the request timer", async () => {
		vi.useFakeTimers();
		const f = fixture((request, emit) =>
			emit({ type: "response", id: request.id, command: request.type, success: true }),
		);
		const failure = new Error("callback failed");
		const result = expect(
			f.client.prompt("hello", {
				preflightResult: () => {
					throw failure;
				},
			}),
		).rejects.toBe(failure);
		await result;
		expect(f.pending()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	test("collects a fast turn whose events arrive before the prompt response", async () => {
		vi.useFakeTimers();
		const f = fixture((request, emit) => {
			emit({ type: "agent_start" });
			emit({ type: "extension_event", name: "irrelevant", data: {} });
			emit({ type: "agent_settled" });
			emit({ type: "response", command: request.type, id: request.id, success: true });
		});
		expect((await f.client.promptAndWait("hello")).map((event) => event.type)).toEqual([
			"agent_start",
			"agent_settled",
		]);
		expect(f.listeners()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("RPC idle waits over a real socket", () => {
	test("idle snapshot resolves without a settlement event, then disconnect rejects active waits", async () => {
		const directory = mkdtempSync(join(tmpdir(), "rpc-client-idle-"));
		const socketPath = join(directory, "rpc.sock");
		let peer: Socket | undefined;
		let active = false;
		const queried = Promise.withResolvers<void>();
		const server = createServer((socket) => {
			peer = socket;
			let buffered = "";
			socket.on("data", (chunk) => {
				buffered += chunk.toString();
				while (true) {
					const newline = buffered.indexOf("\n");
					if (newline === -1) break;
					const request = JSON.parse(buffered.slice(0, newline)) as Request;
					buffered = buffered.slice(newline + 1);
					socket.write(`${JSON.stringify(state(request, active))}\n`);
					if (active) queried.resolve();
				}
			});
		});
		const client = new RpcClient({ socketPath });
		try {
			await new Promise<void>((resolve) => server.listen(socketPath, resolve));
			await client.start();
			await client.waitForIdle();
			active = true;
			const waits = Promise.all([
				expect(client.waitForIdle()).rejects.toBeInstanceOf(RpcTransportGoneError),
				expect(client.collectEvents()).rejects.toBeInstanceOf(RpcTransportGoneError),
			]);
			await queried.promise;
			peer?.destroy();
			await waits;
			expect((Reflect.get(client, "pendingRequests") as Map<string, unknown>).size).toBe(0);
			expect((Reflect.get(client, "eventListeners") as unknown[]).length).toBe(0);
		} finally {
			await client.stop();
			peer?.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
