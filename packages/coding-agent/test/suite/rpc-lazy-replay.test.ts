import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	SocketEventQueueOverflowError,
	SocketEventQueueStallError,
	SocketEventSinkActor,
} from "../../src/modes/rpc/socket-event-fanout.ts";

function gatedSink() {
	let gate = Promise.withResolvers<void>();
	let draining = false;
	return {
		writes: [] as string[],
		writeRaw(line: string) {
			this.writes.push(line);
		},
		waitForBackpressure: () => (draining ? Promise.resolve() : gate.promise),
		release() {
			const previous = gate;
			gate = Promise.withResolvers<void>();
			previous.resolve();
		},
		resume() {
			draining = true;
			gate.resolve();
		},
	};
}

function replay(...lines: string[]) {
	let index = 0;
	return {
		next: vi.fn(
			(): IteratorResult<string> =>
				index < lines.length ? { done: false, value: lines[index++]! } : { done: true, value: undefined },
		),
		return: vi.fn((): IteratorResult<string> => {
			lines = [];
			return { done: true, value: undefined };
		}),
	};
}

describe("lazy socket replay", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it.each([false, true])(
		"yields a writable replay to the event loop and respects close during yield: %s",
		async (close) => {
			vi.useRealTimers();
			let elapsed = 0;
			vi.spyOn(performance, "now").mockImplementation(() => elapsed);
			const history = replay("a\n", "b\n", "c\n", "d\n");
			const next = history.next.getMockImplementation()!;
			history.next.mockImplementation(() => {
				elapsed += 2;
				return next();
			});
			const sink = gatedSink();
			sink.resume();
			const failure = vi.fn();
			const actor = new SocketEventSinkActor(sink, failure);
			let observed: string[] = [];
			const heartbeat = new Promise<void>((resolve) =>
				setImmediate(() => {
					observed = [...sink.writes];
					if (close) actor.close();
					resolve();
				}),
			);
			actor.enqueueReplay(history, 32);
			actor.enqueue("live\n");
			await actor.waitForAcceptance();
			await heartbeat;
			expect(observed).toEqual(["a\n", "b\n"]);
			await actor.flush();
			expect(sink.writes).toEqual(close ? ["a\n", "b\n"] : ["a\n", "b\n", "c\n", "d\n", "live\n"]);
			if (close) {
				expect(history.return).toHaveBeenCalledTimes(1);
				expect(history.next).toHaveBeenCalledTimes(2);
			}
			expect(failure).not.toHaveBeenCalled();
		},
	);

	it("materializes one line per drain and keeps later live records behind the complete replay", async () => {
		const sink = gatedSink();
		const failure = vi.fn();
		const actor = new SocketEventSinkActor(sink, failure);
		const history = replay("replay-1\n", "replay-2\n");
		actor.enqueue("barrier\n");
		actor.enqueueReplay(history, 32);
		actor.enqueue("live-1\n", "message", undefined, "delta-1\n");
		actor.enqueue("live-2\n", "message");
		await actor.waitForAcceptance();
		expect(history.next).not.toHaveBeenCalled();
		sink.release();
		await vi.advanceTimersByTimeAsync(0);
		expect(sink.writes).toEqual(["barrier\n", "replay-1\n"]);
		expect(history.next).toHaveBeenCalledTimes(1);
		sink.release();
		await vi.advanceTimersByTimeAsync(0);
		expect(sink.writes).toEqual(["barrier\n", "replay-1\n", "replay-2\n"]);
		expect(history.next).toHaveBeenCalledTimes(2);
		sink.resume();
		await actor.flush();
		expect(sink.writes).toEqual(["barrier\n", "replay-1\n", "replay-2\n", "delta-1\n", "live-2\n"]);
		expect(failure).not.toHaveBeenCalled();
	});

	it("charges resident replay bytes instead of the total expanded wire length", async () => {
		const sink = gatedSink();
		const failure = vi.fn();
		const actor = new SocketEventSinkActor(sink, failure, 10);
		actor.enqueueReplay(replay("12345678\n", "abcdefgh\n", "ABCDEFGH\n"), 8);
		sink.resume();
		await actor.flush();
		actor.enqueue("123456789\n");
		await actor.flush();
		expect(sink.writes).toEqual(["12345678\n", "abcdefgh\n", "ABCDEFGH\n", "123456789\n"]);
		expect(failure).not.toHaveBeenCalled();
	});

	it("finishes an empty replay and drains a live enqueue while its drain is settling", async () => {
		const sink = gatedSink();
		sink.resume();
		const actor = new SocketEventSinkActor(sink, vi.fn());
		actor.enqueueReplay(replay(), 8);
		actor.enqueue("after\n");
		await actor.flush();
		expect(sink.writes).toEqual(["after\n"]);
	});

	it("keeps the entire replay resident charge until exhausted and releases it on overflow", async () => {
		const sink = gatedSink();
		const failure = vi.fn();
		const actor = new SocketEventSinkActor(sink, failure, 10);
		const history = replay("a\n", "b\n", "c\n");
		actor.enqueueReplay(history, 8);
		sink.release();
		await vi.advanceTimersByTimeAsync(0);
		actor.enqueue("xx\n");
		expect(failure.mock.calls[0]?.[0]).toMatchObject({ queuedBytes: 8, incomingBytes: 3, maxQueueBytes: 10 });
		expect(history.return).toHaveBeenCalledTimes(1);
		sink.resume();
		await actor.flush();
		expect(history.next).toHaveBeenCalledTimes(2);
		expect(sink.writes).toEqual(["a\n", "b\n", '{"type":"overflow","error":"overflow, resync required"}\n']);
	});

	it("rejects an oversized replay line through the ordinary overflow path", async () => {
		const sink = gatedSink();
		const failure = vi.fn();
		const actor = new SocketEventSinkActor(sink, failure, 10);
		const history = replay("0123456789\n");
		actor.enqueueReplay(history, 8);
		await actor.flush();
		expect(failure).toHaveBeenCalledExactlyOnceWith(expect.any(SocketEventQueueOverflowError));
		expect(history.return).toHaveBeenCalledTimes(1);
		expect(sink.writes).toEqual(['{"type":"overflow","error":"overflow, resync required"}\n']);
	});

	it("closes a replay rejected at admission without materializing it", async () => {
		const sink = gatedSink();
		const failure = vi.fn();
		const actor = new SocketEventSinkActor(sink, failure, 10);
		const history = replay("a\n");
		actor.enqueueReplay(history, 11);
		await actor.flush();
		expect(history.next).not.toHaveBeenCalled();
		expect(history.return).toHaveBeenCalledTimes(1);
		expect(failure.mock.calls[0]?.[0]).toMatchObject({ queuedBytes: 0, incomingBytes: 11 });
	});

	it("closes active, queued and subsequently rejected iterators without resuming a stale head", async () => {
		const sink = gatedSink();
		const actor = new SocketEventSinkActor(sink, vi.fn());
		const active = replay("a\n", "b\n");
		const queued = replay("c\n");
		const rejected = replay("d\n");
		actor.enqueueReplay(active, 8);
		actor.enqueueReplay(queued, 8);
		actor.close();
		actor.close();
		actor.enqueueReplay(rejected, 8);
		for (const history of [active, queued, rejected]) expect(history.return).toHaveBeenCalledTimes(1);
		sink.resume();
		await actor.flush();
		expect(active.next).toHaveBeenCalledTimes(1);
		expect(queued.next).not.toHaveBeenCalled();
		expect(rejected.next).not.toHaveBeenCalled();
		expect(sink.writes).toEqual(["a\n"]);
	});

	it("releases every replay when materialization fails", async () => {
		const sink = gatedSink();
		const failure = vi.fn();
		const actor = new SocketEventSinkActor(sink, failure);
		const broken = replay("a\n");
		const queued = replay("b\n");
		const error = new Error("replay failed");
		broken.next.mockImplementation(() => {
			throw error;
		});
		actor.enqueue("barrier\n");
		actor.enqueueReplay(broken, 8);
		actor.enqueueReplay(queued, 8);
		sink.resume();
		await expect(actor.flush()).rejects.toBe(error);
		expect(failure).toHaveBeenCalledExactlyOnceWith(error);
		expect(broken.return).toHaveBeenCalledTimes(1);
		expect(queued.return).toHaveBeenCalledTimes(1);
		expect(queued.next).not.toHaveBeenCalled();
	});

	it("still cuts a stalled replay, releases its cursor and leaves a healthy sibling untouched", async () => {
		const sink = gatedSink();
		const failure = vi.fn();
		const actor = new SocketEventSinkActor(sink, failure, 32, 50);
		const history = replay("a\n", "b\n");
		const healthySink = gatedSink();
		healthySink.resume();
		const healthy = new SocketEventSinkActor(healthySink, failure);
		actor.enqueueReplay(history, 8);
		healthy.enqueueReplay(replay("healthy\n"), 8);
		await vi.advanceTimersByTimeAsync(50);
		await expect(actor.flush()).rejects.toBeInstanceOf(SocketEventQueueStallError);
		await healthy.flush();
		expect(history.return).toHaveBeenCalledTimes(1);
		expect(history.next).toHaveBeenCalledTimes(1);
		expect(failure).toHaveBeenCalledExactlyOnceWith(expect.any(SocketEventQueueStallError));
		expect(sink.writes).toEqual(["a\n", '{"type":"overflow","error":"stalled, resync required"}\n']);
		expect(healthySink.writes).toEqual(["healthy\n"]);
	});
});
