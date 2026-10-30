import { expect, it, vi } from "vitest";
import { SessionWorkerClient } from "../../../src/modes/rpc/session-worker-client.ts";
import type { SessionWorkerToHost } from "../../../src/modes/rpc/session-worker-protocol.ts";

// #4272 / RULING-39: exercise the real client's dispatch fence after real native exit.
it("never dispatches late frames from a terminated worker channel to the consumer", async () => {
	const consume = vi.fn(() => "granted" as const);
	const failure = vi.fn();
	const client = new SessionWorkerClient({
		reserve: consume,
		reconcile: () => {},
		exit: () => {},
		failure,
	});
	try {
		const frame = {
			type: "reserve",
			path: "synthetic-session.jsonl",
			signal: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
		} satisfies SessionWorkerToHost;
		// Positive control: the same channel dispatches a live worker's frame.
		expect(client.worker.emit("message", frame)).toBe(true);
		expect(consume).toHaveBeenCalledExactlyOnceWith(frame.path);
		client.quarantine();
		await client.exited;
		expect(client.worker.threadId).toBe(-1);
		expect(failure).not.toHaveBeenCalled();

		// A dead isolate cannot execute postMessage. Inject late delivery through
		// the real Worker's message event, not a mock client or a private receive call.
		const late = { ...frame, signal: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT) };
		expect(client.worker.emit("message", late)).toBe(false);
		expect(consume).toHaveBeenCalledTimes(1);
	} finally {
		client.quarantine();
		await client.exited;
	}
});
