import { afterEach, describe, expect, it } from "vitest";
import { attach, type DelegatedHost } from "../rpc-delegated-host-support.ts";
import { ASKED, FrameLog, open, permissionHost, probeCalls, remotePeer } from "../rpc-delegated-permission-support.ts";

// senpi#6305: a relayed delivery from an agent on a remote device of the same account (the delegation principal, never
// the record) runs under the receiving session's own preset; every other delegated input keeps the delegated default.

let host: DelegatedHost | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
}, 60_000);

async function deliver(sender: Record<string, unknown> | undefined) {
	host = await permissionHost([], { embedderPreset: true });
	const local = await host.proven();
	const session = await open(local);
	const remote = await remotePeer(host);
	const log = new FrameLog(remote);
	expect(await remote.send(attach(session))).toMatchObject({ success: true });
	return probeCalls(log, { log, peer: remote }, session.sessionId, {
		count: 1,
		answer: "Deny",
		start: async () => {
			const admitted = await remote.send({
				type: "admit_external_message",
				sessionId: session.sessionId,
				deliveryId: "p1",
				text: "read the probe",
				deliverAs: "followUp",
				whenIdle: "start",
				...(sender === undefined ? {} : { sender }),
			});
			expect(admitted).toMatchObject({ success: true });
		},
	});
}

describe("a remote device's delivery and the receiving session's preset", () => {
	it("runs an agent's delivery under the receiving session's own preset", async () => {
		const [call] = await deliver({ kind: "agent", session_id: "peer-session-a", name: "A" });
		expect(call).toEqual({ asked: [], ran: true });
	}, 120_000);

	it("keeps asking for a delivery whose sender is not an agent", async () => {
		const [call] = await deliver({ kind: "external", platform: "slack" });
		expect(call).toEqual({ asked: ASKED, ran: false });
	}, 120_000);

	it("keeps asking for a delivery that names no sender", async () => {
		const [call] = await deliver(undefined);
		expect(call).toEqual({ asked: ASKED, ran: false });
	}, 120_000);
});
