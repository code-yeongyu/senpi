/**
 * senpi#6190 review: a retained session that switches to a new transcript (`new_session`) must be restored on the
 * transcript it is on, never the one it left, and a switched session that was then closed must not come back at
 * all. The handover-parked record is keyed by session path, so the record has to follow the switch.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHostDaemonPaths } from "../src/modes/rpc/host-daemon-paths.ts";
import { readHandoverParkedSessions } from "../src/modes/rpc/host-handover-parked.ts";
import { startFakeModelServer } from "./helpers/rpc-fake-model.ts";
import { writeRpcModelsJson } from "./helpers/rpc-hermetic.ts";
import type { JsonlPeer } from "./helpers/rpc-jsonl-peer.ts";
import {
	expectRestored,
	type OpenedSession,
	openWithTurn,
	RECORD_WAIT_MS,
	runTurn,
	startHost,
	stopHost,
} from "./helpers/rpc-restart-retained-support.ts";
import { connectPeer, scratch } from "./helpers/rpc-socket-host-support.ts";

async function switchWithTurn(peer: JsonlPeer, session: OpenedSession, label: string): Promise<OpenedSession> {
	const seen = peer.messages.length;
	const replaced = peer.waitFor(
		(value) =>
			value.type === "session_replaced" &&
			(value.sessionId === undefined || value.sessionId === session.handle) &&
			peer.messages.indexOf(value) >= seen,
		RECORD_WAIT_MS,
	);
	const switched = await peer.request({ id: `new-${label}`, type: "new_session", sessionId: session.handle });
	expect(switched.success).toBe(true);
	const record = await replaced;
	const prompt = `first-turn-${label}`;
	await runTurn(peer, session.handle, prompt);
	return {
		handle: session.handle,
		durableId: String(record.durableSessionId),
		sessionFile: String(record.sessionFile),
		prompt,
	};
}

describe.skipIf(process.platform === "win32")("a retained session that switched transcripts (senpi#6190)", () => {
	it("is restored on its current transcript only, and a closed switched session never comes back", async () => {
		const qa = scratch("switch");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const host = await startHost(qa);
		const opener = await connectPeer(qa.socketPath);
		try {
			const kept = await openWithTurn(opener.peer, qa.cwd, "kept");
			const keptNow = await switchWithTurn(opener.peer, kept, "kept-now");
			const closed = await openWithTurn(opener.peer, qa.cwd, "closed");
			await switchWithTurn(opener.peer, closed, "closed-now");
			const closing = await opener.peer.request({ id: "close", type: "close_session", sessionId: closed.handle });
			expect(closing.success).toBe(true);
			await stopHost(host, "SIGKILL");

			const socket = join(realpathSync(dirname(qa.socketPath)), basename(qa.socketPath));
			const daemonDir = createHostDaemonPaths({ socket, agentDir: realpathSync(qa.agentDir) }).dir;
			const recorded = (await readHandoverParkedSessions(daemonDir)).map((entry) => entry.sessionPath);
			expect(recorded).toEqual([keptNow.sessionFile]);
			await expectRestored(qa, [keptNow]);
		} finally {
			opener.socket.destroy();
			await fake.close();
		}
	}, 240_000);
});
