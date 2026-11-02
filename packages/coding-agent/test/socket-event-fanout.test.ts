import { describe, expect, it } from "vitest";
import { SocketEventQueueOverflowError, SocketEventSinkActor } from "../src/modes/rpc/socket-event-fanout.ts";

type GatedSink = {
	writes: string[];
	writeRaw(chunk: string): void;
	waitForBackpressure(): Promise<void>;
	releaseBackpressure(): void;
};

function gatedSink(): GatedSink {
	let release: (() => void) | undefined;
	return {
		writes: [],
		writeRaw(chunk: string) {
			this.writes.push(chunk);
		},
		waitForBackpressure() {
			return new Promise<void>((resolve) => {
				release = resolve;
			});
		},
		releaseBackpressure() {
			release?.();
			release = undefined;
		},
	};
}

describe("SocketEventSinkActor", () => {
	it("delivers both records across sequential enqueues", async () => {
		const sink = gatedSink();
		const actor = new SocketEventSinkActor(sink, () => {});
		actor.enqueue("a\n");
		sink.releaseBackpressure();
		await actor.flush();
		actor.enqueue("b\n");
		sink.releaseBackpressure();
		await actor.flush();
		expect(sink.writes).toEqual(["a\n", "b\n"]);
	});

	it("drains a record enqueued while the previous drain is settling", async () => {
		const sink = gatedSink();
		const actor = new SocketEventSinkActor(sink, () => {});

		// First record: drain starts synchronously, writes, then suspends on backpressure.
		actor.enqueue("a\n");
		expect(sink.writes).toEqual(["a\n"]);

		// Release backpressure: the drain loop's resume reaction (R1) is now queued.
		// Queue the racing enqueue as the NEXT microtask (R2): it runs after the loop
		// exited and the async function resolved, but BEFORE the .finally reaction
		// (R3) clears `draining`. The stale settled promise is returned and no new
		// drain starts, so without the reschedule guard "b" never reaches the sink.
		sink.releaseBackpressure();
		queueMicrotask(() => actor.enqueue("b\n"));
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		sink.releaseBackpressure();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		expect(sink.writes).toEqual(["a\n", "b\n"]);
	});

	it("keeps a superseded keyed record as its delta-only form instead of dropping it", async () => {
		// Given: the reader is stalled (backpressure never released), so two
		// message_update snapshots with the same key pile up behind a barrier.
		const sink = gatedSink();
		const actor = new SocketEventSinkActor(sink, () => {});
		actor.enqueue("barrier\n");
		expect(sink.writes).toEqual(["barrier\n"]);
		actor.enqueue('{"delta":"hel","message":{"full":1}}\n', "message", undefined, '{"delta":"hel","message":null}\n');
		actor.enqueue('{"delta":"lo ","message":{"full":2}}\n', "message", undefined, '{"delta":"lo ","message":null}\n');
		actor.enqueue(
			'{"delta":"world","message":{"full":3}}\n',
			"message",
			undefined,
			'{"delta":"world","message":null}\n',
		);

		// When: the reader drains.
		for (let i = 0; i < 4; i++) {
			sink.releaseBackpressure();
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}

		// Then: every delta reaches the wire in order; only the newest record still
		// carries the snapshot. The previous behaviour delivered just the last line,
		// losing "hel" and "lo " for a client that assembles text from deltas.
		expect(sink.writes).toEqual([
			"barrier\n",
			'{"delta":"hel","message":null}\n',
			'{"delta":"lo ","message":null}\n',
			'{"delta":"world","message":{"full":3}}\n',
		]);
	});

	it("replaces a superseded keyed record that has no delta-only form (legacy caller)", async () => {
		const sink = gatedSink();
		const actor = new SocketEventSinkActor(sink, () => {});
		actor.enqueue("barrier\n");
		actor.enqueue("progress-1\n", "tool:1");
		actor.enqueue("progress-2\n", "tool:1");
		for (let i = 0; i < 3; i++) {
			sink.releaseBackpressure();
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
		// Without a demoted form the earlier record is kept verbatim (no key), so
		// nothing is lost; latest-wins compaction is the producer's call.
		expect(sink.writes).toEqual(["barrier\n", "progress-1\n", "progress-2\n"]);
	});

	it("reports overflow with the queue shape and stops delivering", async () => {
		const sink = gatedSink();
		const failures: unknown[] = [];
		const actor = new SocketEventSinkActor(sink, (cause) => failures.push(cause), 16);
		// "a" goes in flight immediately (the drain starts synchronously and parks
		// on backpressure); the next record is what stays queued.
		actor.enqueue("a\n");
		actor.enqueue("0123456789\n");
		actor.enqueue("abcdefghijklmnop\n");
		expect(failures).toHaveLength(1);
		const failure = failures[0];
		expect(failure).toBeInstanceOf(SocketEventQueueOverflowError);
		if (failure instanceof SocketEventQueueOverflowError) {
			expect(failure.queuedBytes).toBe(11);
			expect(failure.incomingBytes).toBe(17);
			expect(failure.maxQueueBytes).toBe(16);
			expect(failure.incomingPreview).toBe("abcdefghijklmnop\n");
		}
		expect(sink.writes.at(-1)).toBe('{"type":"overflow","error":"overflow, resync required"}\n');
		actor.enqueue("after\n");
		sink.releaseBackpressure();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(sink.writes.filter((line) => line === "after\n")).toHaveLength(0);
	});
});
