// senpi#5924 (R3 review MEDIUM-5): `hand_link` is exempt from the cross-account ask because it starts no turn and its
// consent is the forwarder's, never because its sender is treated as the same account. A managed peer that drives this
// machine's hand through `hand_link` stays cross-account: its `admit_external_message` still asks.
import { afterEach, expect, it } from "vitest";
import { attach, type DelegatedHost, declare } from "../rpc-delegated-host-support.ts";
import { ASKED, DEVICE, FrameLog, open, permissionHost, probeCalls } from "../rpc-delegated-permission-support.ts";
import { batch, brain, call, handLinkOn, handProbe, pump, resultText } from "../rpc-hand-link-support.ts";

let host: DelegatedHost | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
}, 60_000);

it("a managed peer's admit_external_message still asks after its hand_link batches ran tools here", async () => {
	host = await permissionHost([], { embedderPreset: true, handLink: handLinkOn(handProbe()) });
	const session = await open(await host.proven());
	const peer = await host.proven();
	const granted = ["observe", "drive", "thread", "answer", "hand_link"];
	expect(await declare(peer, granted, DEVICE, { roles: ["peer_agent"] })).toMatchObject({ success: true });
	expect(await peer.send(attach(session))).toMatchObject({ success: true });
	const hosted = brain("hosted-1", 1);
	expect(resultText(await pump(peer, hosted, call(hosted, host.cwd, "count", {})))).toBe(`counted in ${host.cwd}`);
	expect(await batch(peer, hosted)).toMatchObject({ success: true });

	const log = new FrameLog(peer);
	const calls = await probeCalls(log, { log, peer }, session.sessionId, {
		count: 1,
		answer: "Deny",
		start: () =>
			peer.send({
				type: "admit_external_message",
				sessionId: session.sessionId,
				deliveryId: "managed-peer",
				text: "read the probe",
				deliverAs: "followUp",
				whenIdle: "start",
				sender: { kind: "agent", session_id: "peer-session-a", name: "A" },
			}),
	});

	expect(calls).toEqual([{ asked: ASKED, ran: false }]);
}, 120_000);
