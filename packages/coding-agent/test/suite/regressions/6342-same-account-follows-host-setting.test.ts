import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
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

// senpi#6342: a turn follows the permission setting of the machine it runs on; a same-account origin never changes it,
// and no origin outlives the turn it started. A connection the forwarder did not state as same-account still asks.

const GRANT = ["observe", "drive", "thread", "answer"];
const RAN = { asked: [], ran: true };
const AGENT = { kind: "agent", session_id: "peer-session-a", name: "A" };

let armed = false;
const engineFollowUp: ExtensionFactory = (pi) => {
	pi.on("agent_end", () => {
		if (!armed) return;
		armed = false;
		pi.sendUserMessage("engine turn", { deliverAs: "followUp" });
	});
};

let host: DelegatedHost | undefined;
afterEach(async () => {
	armed = false;
	await host?.dispose();
	host = undefined;
}, 60_000);

async function sameAccountPeer(target: DelegatedHost, roles?: readonly string[]): Promise<Peer> {
	const peer = await target.proven();
	const declared = await declare(peer, GRANT, { ...DEVICE, sameAccount: true }, roles === undefined ? {} : { roles });
	if (declared.success !== true) throw new Error(`declare_delegation refused: ${JSON.stringify(declared)}`);
	return peer;
}

async function setup(connect: (target: DelegatedHost) => Promise<Peer>) {
	host = await permissionHost([engineFollowUp], { embedderPreset: true });
	const local = await host.proven();
	const session = await open(local);
	const remote = await connect(host);
	expect(await remote.send(attach(session))).toMatchObject({ success: true });
	return { local, remote, id: session.sessionId };
}

const calls = (peer: Peer, id: string, count: number, start: () => Promise<unknown>) => {
	const log = new FrameLog(peer);
	return probeCalls(log, { log, peer }, id, { count, answer: "Deny", start });
};

const deliver = (peer: Peer, id: string, deliveryId: string, sender?: Record<string, unknown>) =>
	peer.send({
		type: "admit_external_message",
		sessionId: id,
		deliveryId,
		text: "read the probe",
		deliverAs: "followUp",
		whenIdle: "start",
		...(sender === undefined ? {} : { sender }),
	});

describe("a turn follows the receiving machine's own setting", () => {
	it("keeps no origin after a remote device's command: a later engine-started turn runs on the host setting", async () => {
		const { local, remote, id } = await setup(remotePeer);
		expect(await calls(remote, id, 1, () => remote.send({ type: "prompt", sessionId: id, message: "go" }))).toEqual([
			{ asked: ASKED, ran: false },
		]);
		armed = true;
		const [localCall, engineCall] = await calls(local, id, 2, () =>
			local.send({ type: "prompt", sessionId: id, message: "go" }),
		);
		expect(localCall).toEqual(RAN);
		expect(engineCall).toEqual(RAN);
	}, 120_000);

	it("runs a same-account device's prompt on the host setting", async () => {
		const { remote, id } = await setup((target) => sameAccountPeer(target));
		expect(await calls(remote, id, 1, () => remote.send({ type: "prompt", sessionId: id, message: "go" }))).toEqual([
			RAN,
		]);
	}, 120_000);

	it("runs a same-account device's delivery on the host setting, whatever its sender", async () => {
		const { remote, id } = await setup((target) => sameAccountPeer(target));
		expect(await calls(remote, id, 1, () => deliver(remote, id, "s1", AGENT))).toEqual([RAN]);
		expect(await calls(remote, id, 1, () => deliver(remote, id, "s2"))).toEqual([RAN]);
	}, 120_000);

	it("still asks for a device the forwarder did not state as same-account, prompt and delivery alike", async () => {
		const { remote, id } = await setup(remotePeer);
		expect(await calls(remote, id, 1, () => remote.send({ type: "prompt", sessionId: id, message: "go" }))).toEqual([
			{ asked: ASKED, ran: false },
		]);
		expect(await calls(remote, id, 1, () => deliver(remote, id, "x1", AGENT))).toEqual([
			{ asked: ASKED, ran: false },
		]);
	}, 120_000);

	it("treats peer_agent as an admission fact only: a cross-account peer lane's agent delivery still asks", async () => {
		const { remote, id } = await setup(async (target) => {
			const peer = await target.proven();
			expect(await declare(peer, GRANT, DEVICE, { roles: ["peer_agent"] })).toMatchObject({ success: true });
			return peer;
		});
		expect(await calls(remote, id, 1, () => deliver(remote, id, "p1", AGENT))).toEqual([
			{ asked: ASKED, ran: false },
		]);
	}, 120_000);
});
