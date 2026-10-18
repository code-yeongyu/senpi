import { expect, it, vi } from "vitest";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";

const RECORDS = 50;
// 50 records of this size are the ~200 KiB burst a streaming turn produces while a
// desktop client is blocked in synchronous work.
const RECORD_TEXT = "x".repeat(4_200);

/** A socket peer that accepts writes but stops draining until `resume()` is called. */
function stalledPeer() {
	const written: string[] = [];
	const cut: string[] = [];
	const waiters: Array<() => void> = [];
	let draining = false;
	return {
		written,
		cut,
		connection: {
			writeRaw: (line: string) => void written.push(line),
			waitForBackpressure: () =>
				draining ? Promise.resolve() : new Promise<void>((resolve) => void waiters.push(resolve)),
			close: () => void cut.push("cut"),
		},
		resume() {
			draining = true;
			for (const waiter of waiters.splice(0)) waiter();
		},
	};
}

// A session worker returns its output credit through waitForSessionBackpressure. Over a
// socket the credit point is ACCEPTANCE into that connection's bounded queue: a client
// that is merely busy must not pace the producing worker, or its credit deadline
// (SESSION_WORKER_LIMITS.controlMs) expires and a healthy session is quarantined.
it("returns worker credit on queue acceptance while a peer stops draining for 10s", async () => {
	vi.useFakeTimers();
	try {
		const peer = stalledPeer();
		const writer = new SessionEventWriter(() => {});
		writer.registerConnection("peer", peer.connection);
		writer.attachConnectionToSession("peer", "rpc-1");
		const start = Date.now();
		// The worker's own loop: one record, then wait for its credit before the next.
		for (let index = 0; index < RECORDS; index++) {
			expect(writer.enqueue("rpc-1", { type: "message_update", index, text: RECORD_TEXT })).toBe(true);
			let credited = false;
			const credit = writer.waitForSessionBackpressure("rpc-1").then(() => {
				credited = true;
			});
			// Zero clock movement: the record is queued, so the credit is already due.
			await vi.advanceTimersByTimeAsync(0);
			expect(credited).toBe(true);
			await credit;
		}
		expect(Date.now() - start).toBe(0);
		// Ten seconds with the peer still not reading. A busy peer is not a dead peer.
		await vi.advanceTimersByTimeAsync(10_000);
		expect(peer.cut).toEqual([]);
		expect(peer.written.filter((line) => line.includes('"overflow"'))).toEqual([]);
		// Everything the session produced while the peer was blocked is still delivered.
		peer.resume();
		await writer.flush();
		expect(peer.written.map((line) => JSON.parse(line).index)).toEqual([...Array(RECORDS).keys()]);
		expect(peer.written.reduce((bytes, line) => bytes + Buffer.byteLength(line), 0)).toBeGreaterThanOrEqual(
			200 * 1024,
		);
	} finally {
		vi.useRealTimers();
	}
});
