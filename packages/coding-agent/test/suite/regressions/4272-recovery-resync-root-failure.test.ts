import { afterEach, expect, it, vi } from "vitest";
import type { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { EVENT_RESYNC_CAPABILITY } from "../../../src/modes/rpc/socket-peer-recovery.ts";
import type { HeldPeer } from "./4272-legacy-view-support.ts";
import { recoveryRig } from "./4272-recovery-support.ts";

// Part of #4272 (S08b, review MEDIUM at 231ab52c2e): the recovery entry the actor dequeued owns the cut's barrier and
// its retained root; every way the actor fails or closes while it holds that entry releases the root.

const STALL_MS = 50;

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

interface FailingPeer extends HeldPeer {
	fail(cause: Error): void;
}

function failingPeer(writer: SessionEventWriter, id: string): FailingPeer {
	const lines: string[] = [];
	let blocked = false;
	const waiters: { resolve: () => void; reject: (cause: Error) => void }[] = [];
	writer.registerConnection(
		id,
		{
			writeRaw: (chunk) => void lines.push(chunk),
			waitForBackpressure: () =>
				blocked
					? new Promise<void>((resolve, reject) => void waiters.push({ resolve, reject }))
					: Promise.resolve(),
		},
		{ maxQueueBytes: 600, stallMs: STALL_MS },
	);
	writer.setConnectionCapabilities(id, [EVENT_RESYNC_CAPABILITY]);
	return {
		lines,
		hold: () => {
			blocked = true;
		},
		release: () => {
			blocked = false;
			for (const { resolve } of waiters.splice(0)) resolve();
		},
		fail: (cause) => {
			for (const { reject } of waiters.splice(0)) reject(cause);
		},
	};
}

/** A peer that sheds, then drains its record in flight and blocks again: its recovery waits for the next drain. */
async function recoveryWaitingToDrain() {
	vi.useFakeTimers();
	const rig = recoveryRig();
	const peer = failingPeer(rig.writer, "held");
	await rig.attach(peer);
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	peer.hold();
	for (let index = 0; index < 200 && rig.checkpoints.open === 0; index++)
		rig.producer().blockDelta("text", 0, "x", index);
	expect(rig.checkpoints.open, "the shed froze its cut").toBe(1);
	expect(rig.lane.liveRoots, "the cut retains its root").toBe(1);
	peer.release();
	peer.hold();
	await vi.advanceTimersByTimeAsync(0);
	expect(
		peer.lines.some((line) => line.includes('"resync_required"')),
		"the gap is not delivered yet",
	).toBe(false);
	const failed = () => stderr.mock.calls.some(([line]) => String(line).includes("connection held event queue failed"));
	return { ...rig, peer, failed };
}

async function expectReleased(rig: Awaited<ReturnType<typeof recoveryWaitingToDrain>>): Promise<void> {
	rig.writer.unregisterConnection("held");
	expect(rig.checkpoints.open, "forgetPeer disposed the cut's lease").toBe(0);
	expect(rig.lane.liveRoots, "the cut's retained root is released").toBe(0);
	rig.lane.retire("close");
	await rig.lane.idle();
}

it("review MEDIUM a peer that misses its liveness ping while its recovery waits to drain releases the cut's retained root", async () => {
	const rig = await recoveryWaitingToDrain();
	await vi.advanceTimersByTimeAsync(STALL_MS);
	expect(
		rig.peer.lines.some((line) => line.includes('"rpc_ping"')),
		"the stall pinged the peer",
	).toBe(true);
	await vi.advanceTimersByTimeAsync(STALL_MS);
	expect(rig.failed(), "the missed ping failed the peer").toBe(true);
	await expectReleased(rig);
});

it("a transport failure while the recovery waits to drain releases the cut's retained root", async () => {
	const rig = await recoveryWaitingToDrain();
	rig.peer.fail(new Error("EPIPE"));
	await vi.advanceTimersByTimeAsync(0);
	expect(rig.failed(), "the transport failure failed the peer").toBe(true);
	await expectReleased(rig);
});

it("closing the peer while its recovery waits to drain releases the cut's retained root", async () => {
	const rig = await recoveryWaitingToDrain();
	rig.writer.unregisterConnection("held");
	await vi.advanceTimersByTimeAsync(0);
	await expectReleased(rig);
});

it("a peer that misses its liveness ping while the cut's gap is being written releases the cut's retained root", async () => {
	const rig = await recoveryWaitingToDrain();
	rig.peer.release();
	rig.peer.hold();
	await vi.advanceTimersByTimeAsync(0);
	expect(
		rig.peer.lines.some((line) => line.includes('"resync_required"')),
		"the gap is in flight",
	).toBe(true);
	await vi.advanceTimersByTimeAsync(STALL_MS * 2);
	expect(rig.failed(), "the missed ping failed the peer").toBe(true);
	await expectReleased(rig);
});
