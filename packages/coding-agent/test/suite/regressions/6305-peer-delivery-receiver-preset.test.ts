import { afterEach, describe, expect, it } from "vitest";
import { attach, type DelegatedHost, declare, type Peer } from "../rpc-delegated-host-support.ts";
import {
	ASKED,
	DEVICE,
	FrameLog,
	open,
	permissionHost,
	probeCalls,
	remotePeer,
} from "../rpc-delegated-permission-support.ts";

// senpi#6305: a relayed delivery runs under the receiving session's own preset only on a connection whose host-mode
// delegation the forwarder granted `peer_agent`; a record that merely labels its sender an agent never earns it.

const GRANT = ["observe", "drive", "thread", "answer"];

let host: DelegatedHost | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
}, 60_000);

async function peerAgent(target: DelegatedHost): Promise<Peer> {
	const peer = await target.proven();
	const declared = await declare(peer, GRANT, DEVICE, { roles: ["peer_agent"] });
	if (declared.success !== true) throw new Error(`declare_delegation refused: ${JSON.stringify(declared)}`);
	return peer;
}

async function deliver(connect: (target: DelegatedHost) => Promise<Peer>, sender: Record<string, unknown> | undefined) {
	host = await permissionHost([], { embedderPreset: true });
	const local = await host.proven();
	const session = await open(local);
	const remote = await connect(host);
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

const AGENT = { kind: "agent", session_id: "peer-session-a", name: "A" };

describe("a remote device's delivery and the receiving session's preset", () => {
	it("runs an agent's delivery under the receiving session's own preset on a forwarder-granted peer_agent connection", async () => {
		const [call] = await deliver(peerAgent, AGENT);
		expect(call).toEqual({ asked: [], ran: true });
	}, 120_000);

	it("keeps asking when a drive-granted connection without peer_agent labels its sender an agent", async () => {
		const [call] = await deliver(remotePeer, AGENT);
		expect(call).toEqual({ asked: ASKED, ran: false });
	}, 120_000);

	it("keeps asking on a peer_agent connection whose delivery names a non-agent sender", async () => {
		const [call] = await deliver(peerAgent, { kind: "external", platform: "slack" });
		expect(call).toEqual({ asked: ASKED, ran: false });
	}, 120_000);

	it("keeps asking on a peer_agent connection whose delivery names no sender", async () => {
		const [call] = await deliver(peerAgent, undefined);
		expect(call).toEqual({ asked: ASKED, ran: false });
	}, 120_000);
});
