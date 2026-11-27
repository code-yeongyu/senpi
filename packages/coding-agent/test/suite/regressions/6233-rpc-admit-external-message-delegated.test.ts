import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_CONTROL_DELIVERY_TYPE } from "../../../src/core/extensions/session-control-types.ts";
import { attach, type DelegatedHost } from "../rpc-delegated-host-support.ts";
import {
	ASKED,
	DEVICE,
	FrameLog,
	open,
	permissionHost,
	probeCalls,
	remotePeer,
} from "../rpc-delegated-permission-support.ts";
import type { Peer } from "../rpc-delegated-host-support.ts";

// senpi#6233 security gate: on a connection that speaks for a remote device, the engine stamps the authenticated
// device into the delivery's metadata (never the payload) while the model reads exactly the text a same-machine delivery
// carries (no device, Q 2026-11-08), keys the delivery id under that device, refuses a sender that would render as this machine's own command line, and makes the
// approval mode govern a peer follow-up a local turn consumes.

let host: DelegatedHost | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
}, 60_000);

async function deliveryEntries(peer: Peer, sessionId: string): Promise<Record<string, unknown>[]> {
	const answer = await peer.send({ type: "get_entries", sessionId });
	const entries = (answer.data as { entries: Record<string, unknown>[] }).entries;
	return entries.filter(
		(entry) => entry.type === "custom_message" && entry.customType === SESSION_CONTROL_DELIVERY_TYPE,
	);
}

describe("admit_external_message from a remote device's connection", () => {
	it("stamps the authenticated device into metadata only, keeps the model text a local delivery's, and keys the id under the device", async () => {
		host = await permissionHost();
		host.faux.setResponses([fauxAssistantMessage("ok")]);
		const remote = await remotePeer(host);
		const log = new FrameLog(remote);
		const { sessionId } = await open(remote);

		const reply = await remote.send({
			type: "admit_external_message",
			sessionId,
			deliveryId: "r1",
			text: "peer text",
			sender: { kind: "agent", session_id: "peer-session", name: "Boss" },
			deliverAs: "followUp",
			whenIdle: "queue",
		});

		expect(reply).toMatchObject({ success: true, data: { kind: "queued" } });
		await remote.send({ type: "prompt", sessionId, message: "go" });
		await log.next((record) => record.type === "agent_end" && record.sessionId === sessionId);
		const [entry] = await deliveryEntries(remote, sessionId);
		expect(entry).toMatchObject({
			details: {
				delivery_id: `device:${DEVICE.deviceId}/r1`,
				remote_origin: DEVICE,
				sender: { kind: "agent", session_id: "peer-session", name: "Boss" },
				display_text: "peer text",
			},
		});
		expect(String(entry?.content)).toBe("peer text");
		expect(String(entry?.content)).not.toContain(DEVICE.deviceId);
	}, 120_000);

	it("refuses a command_line sender, and a remote_origin field, from a remote device", async () => {
		host = await permissionHost();
		const remote = await remotePeer(host);
		const { sessionId } = await open(remote);
		const base = { type: "admit_external_message", sessionId, text: "x", deliverAs: "followUp", whenIdle: "queue" };

		expect(
			await remote.send({ ...base, deliveryId: "r2", sender: { kind: "command_line", user: "owner" } }),
		).toMatchObject({ success: false });
		expect(await remote.send({ ...base, deliveryId: "r3", remote_origin: { deviceId: "forged" } })).toMatchObject({
			success: false,
		});
		expect(await deliveryEntries(remote, sessionId)).toEqual([]);
	}, 120_000);

	it("asks for a gated call a remote device's follow-up causes inside a local turn", async () => {
		// Given: a local turn running on the host default (full-access), held before its answer.
		host = await permissionHost();
		const gate = Promise.withResolvers<void>();
		host.faux.setResponses([
			async () => {
				await gate.promise;
				return fauxAssistantMessage("local done");
			},
			fauxAssistantMessage([fauxToolCall("read", { path: "probe.txt" }, { id: "probe-peer" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const local = await host.proven();
		const localLog = new FrameLog(local);
		const session = await open(local);
		const remote = await remotePeer(host);
		expect(await remote.send(attach(session))).toMatchObject({ success: true });

		// When: a remote device's delivery is queued as a follow-up the local run consumes.
		const [call] = await probeCalls(localLog, { log: localLog, peer: local }, session.sessionId, {
			count: 1,
			answer: "Deny",
			start: async () => {
				await local.send({ type: "prompt", sessionId: session.sessionId, message: "go" });
				const admitted = await remote.send({
					type: "admit_external_message",
					sessionId: session.sessionId,
					deliveryId: "r4",
					text: "read the probe",
					deliverAs: "followUp",
				});
				expect(admitted).toMatchObject({ success: true, data: { kind: "queued" } });
				gate.resolve();
			},
		});

		// Then: the peer's work asks, as a remote follow_up's would.
		expect(call).toEqual({ asked: ASKED, ran: false });
	}, 120_000);
});
