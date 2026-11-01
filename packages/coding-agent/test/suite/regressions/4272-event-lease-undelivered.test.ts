import { afterEach, expect, it, vi } from "vitest";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { FLAG } from "./4272-construction-host-support.ts";

// Part of #4272 (S13a review MEDIUM, PR #4680 r3): a lease exists only for an envelope that reached its peer. The socket
// actor may drop a queued envelope (supersession by a newer keyed record, a recovery shed, an overflow cut and the
// records it releases, the peer's close); every such path releases the lease and its staged copy exactly once, so a slow
// compact peer never reaches the lease bound through envelopes it never saw.

afterEach(() => {
	vi.unstubAllEnvs();
});

const big = (id: string) => ({
	type: "tool_execution_end",
	toolCallId: id,
	result: { content: [{ type: "text", text: `${id} ${"x".repeat(300_000)}` }] },
});
const keyed = (id: string) => {
	const message = { role: "assistant", content: [{ type: "text", text: `${id} ${"k".repeat(300_000)}` }] };
	return {
		type: "message_update",
		message,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: id, partial: message },
	};
};
/** A record past the queue bound but under F: the legacy line, which overflows the queue and cuts. */
const filler = (id: string) => ({ type: "tool_execution_update", toolCallId: id, partialResult: "f".repeat(20_000) });

/** A lane-owned session and one compact peer whose transport is held until `release`. */
function heldCompactPeer(capabilities: readonly string[]) {
	vi.stubEnv(FLAG, "1");
	const writer = new SessionEventWriter(() => {});
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: [] });
	writer.registerAcceptance("s1", lane);
	const received: string[] = [];
	let blocked = true;
	const waiters: (() => void)[] = [];
	writer.registerConnection(
		"peer",
		{
			writeRaw: (chunk) => void received.push(chunk),
			waitForBackpressure: () =>
				blocked ? new Promise<void>((resolve) => void waiters.push(resolve)) : Promise.resolve(),
		},
		{ maxQueueBytes: 16_000 },
	);
	writer.setConnectionCapabilities("peer", ["compact_events", ...capabilities]);
	writer.attachConnectionToSession("peer", "s1");
	writer.enqueue("s1", { type: "agent_start" });
	const events = writer.recoveryEvents ?? expect.unreachable("no event lease owner with the flag on");
	const release = async () => {
		blocked = false;
		for (const resolve of waiters.splice(0)) resolve();
		await writer.flush();
	};
	const envelopes = () =>
		received
			.join("")
			.split("\n")
			.filter((line) => line.includes('"eventLease"'))
			.map((line) => (JSON.parse(line) as { eventLease: { length: number } }).eventLease);
	return { writer, events, release, envelopes, received };
}

const DROPS = [
	{
		path: "supersede",
		capabilities: [],
		run: (w: SessionEventWriter) => ["k1", "k2"].forEach((id) => w.enqueue("s1", keyed(id))),
	},
	{
		path: "cut",
		capabilities: ["event_resync"],
		run: (w: SessionEventWriter) => [big("e1"), filler("f1")].forEach((r) => w.enqueue("s1", r)),
	},
	{
		path: "shed",
		capabilities: ["event_resync"],
		run: (w: SessionEventWriter) =>
			[big("e1"), filler("f1"), filler("f2"), big("e2")].forEach((r) => w.enqueue("s1", r)),
	},
] as const;

it.each(DROPS)(
	"S13a review: a lease whose envelope the actor drops by $path is released with its staged copy",
	async ({ capabilities, run }) => {
		const { writer, events, release, envelopes } = heldCompactPeer(capabilities);
		try {
			run(writer);
			await release();
			const delivered = envelopes();
			const status = events.status();
			expect(status.minted, "the scenario minted a lease the peer never received").toBeGreaterThan(delivered.length);
			expect(
				{ open: status.open, contentBytes: status.contentBytes },
				"a lease exists only for an envelope the peer received",
			).toEqual({ open: delivered.length, contentBytes: delivered.reduce((sum, lease) => sum + lease.length, 0) });
		} finally {
			writer.unregisterConnection("peer");
		}
	},
);

it("S13a review: a peer that closes with envelopes still queued releases every lease and staged copy", async () => {
	const { writer, events, envelopes } = heldCompactPeer([]);
	writer.enqueue("s1", big("e1"));
	writer.enqueue("s1", big("e2"));
	expect(events.status().minted).toBe(2);
	writer.unregisterConnection("peer");
	expect(envelopes()).toHaveLength(0);
	expect(events.status()).toMatchObject({ open: 0, contentBytes: 0 });
});

it("S13a review: a slow compact peer streaming a large message never reaches the lease bound through superseded envelopes", async () => {
	const { writer, events, release, envelopes, received } = heldCompactPeer([]);
	try {
		for (let update = 0; update < events.peerLimit + 8; update++) writer.enqueue("s1", keyed(`u${update}`));
		expect(events.status().open, "only the queued newest envelope holds a lease").toBe(1);
		await release();
		expect(received.join("")).not.toContain("event_lease_refused");
		expect(events.status().refused).toEqual({});
		expect(events.status().open).toBe(envelopes().length);
	} finally {
		writer.unregisterConnection("peer");
	}
});
