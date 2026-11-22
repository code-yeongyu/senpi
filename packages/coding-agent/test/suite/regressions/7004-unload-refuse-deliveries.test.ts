import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { type DelegatedHost, startHost } from "../rpc-delegated-host-support.ts";
import { DEVICE, FrameLog, open, remotePeer } from "../rpc-delegated-permission-support.ts";

// senpi#7004 (oh-my-openagent#14234): a close must never drop a busy session's unread deliveries unless the caller
// allows it. `unload_session { deliveries: "refuse" }` refuses a busy session that holds admitted deliveries not yet
// written, naming them in `pending.deliveries`, before anything is interrupted. An idle session's stranded deliveries
// (senpi#6971's case) are still handed back in that mode, and every work_pending refusal names its deliveries.

const UNLOAD = { type: "unload_session", force: true, interrupt: true, children: "detach" } as const;

let host: DelegatedHost | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
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
	const { sessionId } = await open(remote);
	const deliver = (deliveryId: string) =>
		remote.send({ type: "admit_external_message", sessionId, deliveryId, text: "probe", deliverAs: "followUp" });
	return { host, log, sessionId, deliver, local: await host.proven() };
}

const id = (deliveryId: string) => `device:${DEVICE.deviceId}/${deliveryId}`;

describe('unload_session { deliveries: "refuse" }', () => {
	it("refuses a session that stopped responding mid-run without interrupting it, names its unread deliveries, and replays them", async () => {
		const toolRunning = Promise.withResolvers<void>();
		let aborted = false;
		const tools: ExtensionFactory = (pi) => {
			pi.registerTool({
				name: "stuck",
				label: "stuck",
				description: "never returns, even when aborted",
				parameters: Type.Object({}),
				execute: async (_id, _params, signal) => {
					signal?.addEventListener("abort", () => {
						aborted = true;
					});
					toolRunning.resolve();
					await new Promise<void>(() => {});
					throw new Error("unreachable");
				},
			});
		};
		const { sessionId, deliver, local, host: started } = await remoteSession(tools);
		started.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("stuck", {}, { id: "t-stuck" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("never reached"),
		]);
		expect(await deliver("first")).toMatchObject({ data: { kind: "started" } });
		await toolRunning.promise;
		expect(await deliver("second")).toMatchObject({ data: { kind: "queued" } });
		expect(await deliver("third")).toMatchObject({ data: { kind: "queued" } });

		const pending = { deliveries: [id("second"), id("third")] };
		// Without the option and without interrupt the run is the answer, as before.
		expect(await local.send({ type: "unload_session", sessionId, force: true, children: "detach" })).toMatchObject({
			data: { outcome: "refused", reason: "turn_active" },
		});
		// With it, the unread deliveries are the answer whether or not the caller asked to interrupt.
		expect(
			await local.send({ type: "unload_session", sessionId, force: true, children: "detach", deliveries: "refuse" }),
		).toMatchObject({ data: { outcome: "refused", reason: "work_pending", pending } });
		const refusedAnswer = await local.send({ ...UNLOAD, sessionId, deliveries: "refuse", effectId: "r1" });

		expect(refusedAnswer).toMatchObject({
			success: true,
			data: { outcome: "refused", reason: "work_pending", pending },
		});
		expect((refusedAnswer.data as { dropped?: unknown }).dropped).toBeUndefined();
		expect(aborted).toBe(false);
		expect(await local.send({ type: "get_state", sessionId })).toMatchObject({ data: { isStreaming: true } });
		expect(await local.send({ ...UNLOAD, sessionId, deliveries: "refuse", effectId: "r1" })).toMatchObject({
			data: { outcome: "refused", reason: "work_pending", pending, replayed: true },
		});
		// The option is part of the effect: the same id without it is another request, never a replay of the refusal.
		expect(await local.send({ ...UNLOAD, sessionId, effectId: "r1" })).toMatchObject({
			success: false,
			errorCode: "effect_id_conflict",
		});

		// The caller chose to drop them: the default mode interrupts and names what it handed back.
		expect(await local.send({ ...UNLOAD, sessionId })).toMatchObject({
			success: true,
			data: { outcome: "unloaded", dropped: pending },
		});
	});

	it("still hands back an idle session's stranded deliveries left by an interrupted run (senpi#6971)", async () => {
		const toolRunning = Promise.withResolvers<void>();
		const tools: ExtensionFactory = (pi) => {
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
			fauxAssistantMessage([fauxToolCall("hang", {}, { id: "t-hang" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("never reached"),
		]);
		expect(await deliver("first")).toMatchObject({ data: { kind: "started" } });
		await toolRunning.promise;
		expect(await deliver("second")).toMatchObject({ data: { kind: "queued" } });
		const ended = log.next((record) => record.type === "agent_end" && record.sessionId === sessionId);
		await local.send({ type: "abort", sessionId });
		await ended;

		// Without interrupt the stranded delivery is a work_pending refusal that names it.
		expect(await local.send({ type: "unload_session", sessionId, force: true, children: "detach" })).toMatchObject({
			data: { outcome: "refused", reason: "work_pending", pending: { deliveries: [id("second")] } },
		});
		expect(await local.send({ ...UNLOAD, sessionId, deliveries: "refuse" })).toMatchObject({
			success: true,
			data: { outcome: "unloaded", dropped: { deliveries: [id("second")] } },
		});
	});
});
