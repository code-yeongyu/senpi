import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { endAfterPeerFin, PEER_END_REPLY_GRACE_MS, PendingReplies } from "../../src/modes/rpc/host-peer-end.ts";

// oh-my-openagent#14725: after a peer's FIN a host connection waits for the replies it owes, but never longer than its
// grace. The real-host suite (rpc-host-peer-fin.test.ts) proves the replies arrive; these cases own the bound, which no
// real peer can reach in a test's time.
afterEach(() => {
	vi.useRealTimers();
});

function finishedPeer(): PassThrough {
	const stream = new PassThrough();
	stream.resume();
	return stream;
}

const never = () => new Promise<void>(() => {});

describe("endAfterPeerFin (omo#14725)", () => {
	it("closes at the grace when a reply owed since before the FIN never settles", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const stream = finishedPeer();
		const replies = new PendingReplies();
		replies.track(never());
		const close = vi.fn();
		endAfterPeerFin(stream, replies, async () => {}, close);
		stream.end();
		await vi.advanceTimersByTimeAsync(PEER_END_REPLY_GRACE_MS - 1);
		expect(close).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("closes at the grace when the flush after the replies never finishes", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const stream = finishedPeer();
		const close = vi.fn();
		endAfterPeerFin(stream, new PendingReplies(), never, close);
		stream.end();
		await vi.advanceTimersByTimeAsync(PEER_END_REPLY_GRACE_MS - 1);
		expect(close).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("closes once, after the owed reply settled and the flush finished", async () => {
		const stream = finishedPeer();
		const replies = new PendingReplies();
		let settle: () => void = () => {};
		replies.track(new Promise<void>((resolve) => (settle = resolve)));
		const order: string[] = [];
		const closed = new Promise<void>((resolve) =>
			endAfterPeerFin(
				stream,
				replies,
				async () => {
					order.push("flush");
				},
				() => {
					order.push("close");
					resolve();
				},
			),
		);
		stream.end();
		await new Promise<void>((resolve) => stream.once("end", resolve));
		expect(order).toEqual([]);
		settle();
		await closed;
		expect(order).toEqual(["flush", "close"]);
	});
});
