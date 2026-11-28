import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { deliveryIdOf } from "../../../src/core/delivery-ids.ts";
import { messageTicket } from "../../../src/core/lifecycle-delivery.ts";
import { abortAndSettle } from "../../../src/modes/rpc/session-release-interrupt.ts";
import { createIdentityHarness } from "../rpc-client-identity-harness.ts";
import { type DelegatedHost, startHost } from "../rpc-delegated-host-support.ts";
import { DEVICE, FrameLog, open, operatorOn, remotePeer } from "../rpc-delegated-permission-support.ts";

// oh-my-openagent#14169: a delivery a remote device admitted is left queued, unwritten, by an interrupted run: one that
// arrived while the run was busy waits in the follow-up queue, and one whose start the abort cut short is queued again
// under its engine ticket. Its admission stayed pending, and every unload_session { force, interrupt } was refused
// work_pending forever. The interrupting unload now hands such deliveries back (named in `dropped.deliveries`, live and
// on an effect replay; custody cancelled, so a reopen never replays one the sender redelivers) and unloads.

const UNLOAD = { type: "unload_session", force: true, interrupt: true, children: "detach" } as const;

const SETTLED = { otherRequestsSettled: async () => {}, pendingPrompts: () => [] };

let host: DelegatedHost | undefined;
const harnesses: Awaited<ReturnType<typeof createIdentityHarness>>[] = [];
afterEach(async () => {
	await host?.dispose();
	host = undefined;
	for (const fixture of harnesses.splice(0)) await fixture.cleanup();
}, 60_000);

async function remoteSession(extension: ExtensionFactory) {
	host = await startHost({ extensionFactories: [extension] });
	const remote = await remotePeer(host);
	const log = new FrameLog(remote);
	// A delegated turn asks before each tool; the remote device allows them.
	log.next((record) => {
		if (record.type === "extension_ui_request" && record.method === "select")
			remote.socket.write(
				`${JSON.stringify({ type: "extension_ui_response", sessionId: record.sessionId, id: record.id, value: "Allow once" })}\n`,
			);
		return false;
	}).catch(() => {});
	const opened = await open(remote);
	const { sessionId } = opened;
	const deliver = (deliveryId: string) =>
		remote.send({ type: "admit_external_message", sessionId, deliveryId, text: "probe", deliverAs: "followUp" });
	return { host, log, sessionId, deliver, local: await operatorOn(host, opened) };
}

describe("unload_session with an unwritten delivery left behind by an interrupted run", () => {
	it("hands back a delivery queued behind the run, and records it on the unload's effect", async () => {
		const toolRunning = Promise.withResolvers<void>();
		const tools: ExtensionFactory = (pi) => {
			pi.registerTool({
				name: "fast",
				label: "fast",
				description: "returns at once",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			});
			pi.registerTool({
				name: "hang",
				label: "hang",
				description: "runs until aborted",
				parameters: Type.Object({}),
				execute: async (_id, _params, signal) => {
					toolRunning.resolve();
					await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
					throw new Error("aborted");
				},
			});
		};
		const { log, sessionId, deliver, local, host: started } = await remoteSession(tools);
		started.faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("fast", {}, { id: "t-fast" }), fauxToolCall("hang", {}, { id: "t-hang" })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("never reached"),
		]);

		expect(await deliver("first")).toMatchObject({ data: { kind: "started" } });
		await toolRunning.promise;
		expect(await deliver("second")).toMatchObject({ data: { kind: "queued" } });
		const ended = log.next((record) => record.type === "agent_end" && record.sessionId === sessionId);
		await local.send({ type: "abort", sessionId });
		await ended;

		const unloaded = await local.send({ ...UNLOAD, sessionId, effectId: "u1" });

		const dropped = { deliveries: [`device:${DEVICE.deviceId}/second`] };
		expect(unloaded).toMatchObject({ success: true, data: { outcome: "unloaded", dropped } });
		const sessionPath = String((unloaded.data as { sessionPath?: string }).sessionPath);
		const status = await local.send({ type: "get_effect_status", effectId: "u1", sessionPath });
		expect(status).toMatchObject({
			success: true,
			data: { effect: { state: "done", disposition: "unloaded", dropped } },
		});
	}, 120_000);

	it("hands back a delivery whose start the abort cut short, queued again under its engine ticket", async () => {
		const startCut = Promise.withResolvers<void>();
		const abortFirstDeliveryStart: ExtensionFactory = (pi) => {
			pi.on("before_agent_start", (event, ctx) => {
				if (event.trigger !== "delivery") return;
				// The person stops the session while the delivery's turn is being admitted: it is queued again under its ticket.
				ctx.abort("user");
				startCut.resolve();
			});
		};
		const fixture = await createIdentityHarness({ extensionFactories: [abortFirstDeliveryStart] });
		harnesses.push(fixture);
		const rpc = fixture.bind();
		const session = fixture.session;

		expect(
			await rpc.send({
				type: "admit_external_message",
				deliveryId: "ticketed",
				text: "probe",
				deliverAs: "followUp",
			}),
		).toMatchObject({ data: { kind: "started" } });
		await startCut.promise;
		await session.waitForIdle();
		const carriers = () => session.agent.peekQueuedMessages({ all: true }).filter((queued) => deliveryIdOf(queued));
		expect(carriers().map((queued) => (queued.role === "custom" ? messageTicket(queued) : undefined))).toEqual([
			expect.any(String),
		]);

		const handedBack = await abortAndSettle(SETTLED, "s1", session);

		expect(handedBack).toEqual(["rpc:local/ticketed"]);
		expect(carriers()).toEqual([]);
		expect(session.externalAdmission.list().pending).toEqual([]);
	});
});
