import { afterEach, expect, it, vi } from "vitest";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";
import { FLAG } from "./4272-construction-host-support.ts";
import { specDigest } from "./4272-frozen-bytes-support.ts";

// Regression for #5346 (RULING-123 under S13 X07): a compact peer's copy of a live call record carries its stamp, and
// that stamped copy is built once per delivery, so N compact peers of one oversized record lease ONE staged copy of
// the stamped text. e1a73bab3c built the stamped object per peer and staged N copies.

const PEERS = 3;
const big = {
	type: "tool_execution_end",
	toolCallId: "c-shared",
	result: { content: [{ type: "text", text: "z".repeat(300_000) }] },
};

afterEach(() => {
	vi.unstubAllEnvs();
});

it("three compact peers of one oversized call record lease one staged copy of its stamped text", async () => {
	vi.stubEnv(FLAG, "1");
	const host = await statusHost();
	try {
		const opener = host.client("opener");
		const routing = String(dataOf(await opener.request({ type: "open_session", cwd: host.cwd })).sessionId);
		host.writer.detachConnectionFromSession("opener", routing);
		const peers = Array.from({ length: PEERS }, (_, index) => {
			const name = `compact-${index}`;
			const client = host.client(name);
			host.writer.setConnectionCapabilities(name, ["compact_events"]);
			host.writer.attachConnectionToSession(name, routing);
			return client;
		});
		const events = host.writer.recoveryEvents ?? expect.unreachable("no event lease owner with the flag on");
		host.writer.enqueue(routing, big);
		await host.writer.flush();
		// The call was never announced, so its compact copy is the legacy text plus `callUnknown: true`.
		const stamped = Buffer.from(JSON.stringify({ ...big, sessionId: routing, callUnknown: true }), "utf16le");
		expect(events.status(), "lease accounting is 1x the stamped copy for all three peers").toMatchObject({
			open: PEERS,
			minted: PEERS,
			contentBytes: stamped.length,
		});
		for (const peer of peers) {
			const leases = peer.inbox.flatMap((record) => (record.eventLease === undefined ? [] : [record.eventLease]));
			expect(leases, "each peer holds one lease on the stamped text").toEqual([
				expect.objectContaining({ length: stamped.length, digest: specDigest("leaf", stamped) }),
			]);
		}
	} finally {
		await host[Symbol.asyncDispose]();
	}
}, 300_000);
