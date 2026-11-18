import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { type DelegatedHost, startHost } from "../rpc-delegated-host-support.ts";
import { DEVICE, FrameLog, open, remotePeer } from "../rpc-delegated-permission-support.ts";

// oh-my-openagent#14169: a delivery a remote device admitted while a run was busy waits in the follow-up queue. When
// that run is interrupted the delivery is never written, so the admission ledger keeps it pending, and every
// unload_session { force, interrupt } was refused work_pending forever. The interrupting unload now hands such a
// delivery back (named in `dropped.deliveries`, unwritten, so its sender redelivers it) and unloads.

let host: DelegatedHost | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
}, 60_000);

describe("unload_session with an unwritten delivery left behind by an interrupted run", () => {
	it("hands the delivery back and unloads instead of refusing work_pending forever", async () => {
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
		host = await startHost({ extensionFactories: [tools] });
		host.faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("fast", {}, { id: "t-fast" }), fauxToolCall("hang", {}, { id: "t-hang" })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("never reached"),
		]);
		const remote = await remotePeer(host);
		const log = new FrameLog(remote);
		// The delegated turn asks before each tool; the remote device allows them.
		log.next((record) => {
			if (record.type === "extension_ui_request" && record.method === "select")
				remote.socket.write(
					`${JSON.stringify({ type: "extension_ui_response", sessionId: record.sessionId, id: record.id, value: "Allow once" })}\n`,
				);
			return false;
		}).catch(() => {});
		const { sessionId } = await open(remote);
		const delivery = { type: "admit_external_message", sessionId, text: "probe", deliverAs: "followUp" };

		expect(await remote.send({ ...delivery, deliveryId: "first" })).toMatchObject({ data: { kind: "started" } });
		await toolRunning.promise;
		expect(await remote.send({ ...delivery, deliveryId: "second" })).toMatchObject({ data: { kind: "queued" } });
		const local = await host.proven();
		const ended = log.next((record) => record.type === "agent_end" && record.sessionId === sessionId);
		await local.send({ type: "abort", sessionId });
		await ended;

		const unloaded = await local.send({
			type: "unload_session",
			sessionId,
			force: true,
			interrupt: true,
			children: "detach",
		});

		expect(unloaded).toMatchObject({
			success: true,
			data: { outcome: "unloaded", dropped: { deliveries: [`device:${DEVICE.deviceId}/second`] } },
		});
	}, 120_000);
});
