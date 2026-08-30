import { describe, expect, it } from "vitest";
import { SocketEventSinkActor } from "../src/modes/rpc/socket-event-fanout.ts";

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
});
