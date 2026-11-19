/**
 * senpi#7020 (gate 1): a socket host dies under a retained session while the ENGINE is running its turn (a peer's
 * delivery started it). The next host on the same socket reopens the session from its record, and the session goes
 * back to work by itself: a model request reaches the provider with no client connected and nothing sent. Before the
 * fix the reopen forced the session unattended, so the cut run stayed held until a person came back.
 */
import { describe, expect, it } from "vitest";
import { startFakeModelServer } from "../../helpers/rpc-fake-model.ts";
import { writeRpcModelsJson } from "../../helpers/rpc-hermetic.ts";
import { HOLD_MARKER, openWithTurn, startHost, stopHost } from "../../helpers/rpc-restart-retained-support.ts";
import { connectPeer, scratch } from "../../helpers/rpc-socket-host-support.ts";

/** Each step's bound, inside the suite's 30 s test timeout: a session that never resumes fails here, named. */
const STEP_MS = 20_000;

describe.skipIf(process.platform === "win32")("an engine run cut by a host restart (senpi#7020)", () => {
	it.each(["SIGKILL", "SIGTERM"] as const)(
		"resumes on the next host with no client input after %s",
		async (signal) => {
			const qa = scratch(`resume-${signal.toLowerCase()}`);
			const fake = await startFakeModelServer({ holdOnLastMessage: HOLD_MARKER });
			writeRpcModelsJson(qa.agentDir, fake.origin);
			const host = await startHost(qa);
			const opener = await connectPeer(qa.socketPath);
			try {
				const session = await openWithTurn(opener.peer, qa.cwd, "lane");
				const cut = fake.waitForRequest((request) => request.latest.includes(HOLD_MARKER), STEP_MS);
				const admitted = await opener.peer.request({
					id: "peer-delivery",
					type: "admit_external_message",
					sessionId: session.handle,
					deliveryId: "lead-1",
					text: `[from lead] ${HOLD_MARKER}`,
					deliverAs: "followUp",
				});
				expect(admitted).toMatchObject({ success: true, data: { kind: "started" } });
				await cut;
				opener.socket.destroy();
				await stopHost(host, signal);

				const before = fake.requests.length;
				const resumed = fake.waitForRequest((_, index) => index >= before, STEP_MS);
				// The restarted host gets no connection and no input: whatever reaches the model now, the session sent.
				await startHost(qa);
				const request = await resumed;
				expect(request.latest).not.toContain(HOLD_MARKER);
			} finally {
				opener.socket.destroy();
				await fake.close();
			}
		},
	);
});
