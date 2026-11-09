/**
 * senpi#6190: retained sessions survive their socket host. Whether the host is killed or stopped cleanly, and
 * whether the session was idle or mid-turn, the next host on the same socket and agent dir lists it again with
 * its durable id and transcript and a viewer can attach and prompt - the remote equivalent of a TUI resuming its
 * session file. A clean stop parks a retained session (`session_parked`, never `session_closed`), and a turn the
 * stop cuts short ends as a host shutdown, never as a user abort.
 */
import { describe, expect, it } from "vitest";
import { startFakeModelServer } from "./helpers/rpc-fake-model.ts";
import { writeRpcModelsJson } from "./helpers/rpc-hermetic.ts";
import type { RecordValue } from "./helpers/rpc-jsonl-peer.ts";
import {
	expectRestored,
	HOLD_MARKER,
	openWithTurn,
	RECORD_WAIT_MS,
	startHeldTurn,
	startHost,
	stopHost,
} from "./helpers/rpc-restart-retained-support.ts";
import { connectPeer, scratch } from "./helpers/rpc-socket-host-support.ts";

describe.skipIf(process.platform === "win32")("retained sessions across a socket host restart (senpi#6190)", () => {
	it("restores an idle and a mid-turn retained session after the host is killed", async () => {
		const qa = scratch("kill");
		const fake = await startFakeModelServer({ holdOnLastMessage: HOLD_MARKER });
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = await startHost(qa);
		const opener = await connectPeer(qa.socketPath);
		try {
			const idle = await openWithTurn(opener.peer, qa.cwd, "idle");
			const busy = await openWithTurn(opener.peer, qa.cwd, "busy");
			await startHeldTurn(opener.peer, busy);
			await stopHost(host, "SIGKILL");
			await expectRestored(qa, [idle, busy]);
		} finally {
			opener.socket.destroy();
			await fake.close();
		}
	}, 240_000);

	it("parks retained sessions on a clean stop, ends the cut turn as a host shutdown, and restores both", async () => {
		const qa = scratch("stop");
		const fake = await startFakeModelServer({ holdOnLastMessage: HOLD_MARKER });
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = await startHost(qa);
		const opener = await connectPeer(qa.socketPath);
		try {
			const idle = await openWithTurn(opener.peer, qa.cwd, "idle");
			const busy = await openWithTurn(opener.peer, qa.cwd, "busy");
			await startHeldTurn(opener.peer, busy);
			const seen = opener.peer.messages.length;
			const fresh = (value: RecordValue) => opener.peer.messages.indexOf(value) >= seen;
			const cutTurn = opener.peer.waitFor(
				(value) => value.type === "agent_end" && value.sessionId === busy.handle && fresh(value),
				RECORD_WAIT_MS,
			);
			const parked = [idle, busy].map((session) =>
				opener.peer.waitFor(
					(value) => value.type === "session_parked" && value.sessionId === session.handle,
					RECORD_WAIT_MS,
				),
			);
			await stopHost(host, "SIGTERM");

			expect(await cutTurn).toMatchObject({
				aborted: true,
				abortSource: "system",
				abortCause: { kind: "host_shutdown" },
			});
			for (const record of await Promise.all(parked)) expect(record).toMatchObject({ reason: "host_shutdown" });
			const closed = opener.peer.messages.filter(
				(value) =>
					value.type === "session_closed" && (value.sessionId === idle.handle || value.sessionId === busy.handle),
			);
			expect(closed).toEqual([]);
			await expectRestored(qa, [idle, busy]);
		} finally {
			opener.socket.destroy();
			await fake.close();
		}
	}, 240_000);
});
