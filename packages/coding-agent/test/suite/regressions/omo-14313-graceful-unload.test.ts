import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { type DelegatedHost, startHost } from "../rpc-delegated-host-support.ts";
import { DEVICE, FrameLog, open, remotePeer } from "../rpc-delegated-permission-support.ts";

// oh-my-openagent#14313: `unload_session { graceful: true }` closes a busy session without interrupting it. New
// deliveries are refused `session_closing` at once, queued ones are handed back unread, the running turn ends on its
// own, and the session ends with a clean-stop record: a reopen finds no interrupted run and no hold. A drain that
// outlives `waitMs` leaves the session open and admitting again.

const GRACEFUL = { type: "unload_session", graceful: true, force: true, children: "detach" } as const;

let host: DelegatedHost | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
}, 60_000);

function gatedTool() {
	const running = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const seen = { aborted: false, shutdowns: [] as Array<{ reason: string; closed?: true }> };
	const extension: ExtensionFactory = (pi) => {
		pi.registerTool({
			name: "gate",
			label: "gate",
			description: "runs until released",
			parameters: Type.Object({}),
			execute: async (_id, _params, signal) => {
				running.resolve();
				signal?.addEventListener("abort", () => {
					seen.aborted = true;
					finish.resolve();
				});
				await finish.promise;
				return { content: [{ type: "text", text: "gate released" }], details: {} };
			},
		});
		pi.on("session_shutdown", (event) => {
			seen.shutdowns.push({ reason: event.reason, ...(event.closed === true ? { closed: true } : {}) });
		});
	};
	return { extension, running: running.promise, release: () => finish.resolve(), seen };
}

async function busySession(extension: ExtensionFactory) {
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
		remote.send({ type: "admit_external_message", sessionId, deliveryId, text: deliveryId, deliverAs: "followUp" });
	host.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("gate", {}, { id: "t-gate" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("first turn done"),
		fauxAssistantMessage("reopened turn done"),
	]);
	return { host, log, sessionId, deliver, local: await host.proven() };
}

const id = (deliveryId: string) => `device:${DEVICE.deviceId}/${deliveryId}`;

function customEntries(sessionPath: string): Array<{ customType: string; data: Record<string, unknown> }> {
	return readFileSync(sessionPath, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as { type: string; customType?: string; data?: Record<string, unknown> })
		.filter((entry) => entry.type === "custom" && typeof entry.customType === "string")
		.map((entry) => ({ customType: String(entry.customType), data: entry.data ?? {} }));
}

describe("unload_session { graceful: true }", () => {
	it("drains a busy session without interrupting it, refuses new deliveries typed and reopens with no hold", async () => {
		const gate = gatedTool();
		const { log, sessionId, deliver, local } = await busySession(gate.extension);
		expect(await deliver("first")).toMatchObject({ data: { kind: "started" } });
		await gate.running;
		expect(await deliver("second")).toMatchObject({ data: { kind: "queued" } });

		const fenced = log.next((record) => record.type === "session_paused" && record.sessionId === sessionId);
		const closing = local.send({ ...GRACEFUL, sessionId, waitMs: 30_000, effectId: "g1" });
		await fenced;
		// The fence is up: a new delivery is refused typed, the queued one already left the session.
		expect(await deliver("third")).toMatchObject({ success: false, errorCode: "session_closing" });
		expect(await local.send({ type: "get_state", sessionId })).toMatchObject({ data: { isStreaming: true } });

		gate.release();
		const closed = await closing;
		expect(closed).toMatchObject({
			success: true,
			data: {
				outcome: "unloaded",
				dropped: { deliveries: [id("second")], user_messages: [] },
				graceful: { turn: 1, stopped: { wake_sources: [] } },
				effect: { state: "done" },
			},
		});
		expect(gate.seen.aborted).toBe(false);
		expect(gate.seen.shutdowns).toEqual([{ reason: "quit", closed: true }]);

		const sessionPath = String((closed.data as { sessionPath: string }).sessionPath);
		const entries = customEntries(sessionPath);
		expect(entries.filter((entry) => entry.customType === "interrupted-run")).toEqual([]);
		expect(entries.filter((entry) => entry.customType === "session-closed")).toMatchObject([
			{ data: { graceful: true, turn: 1, returned: { deliveries: [id("second")], user_messages: [] } } },
		]);
		expect(entries.filter((entry) => entry.customType === "session-hold").map((entry) => entry.data.op)).toEqual([
			"add",
			"release",
		]);

		const reopened = await local.send({ type: "open_session", sessionPath });
		const reopenedId = String((reopened.data as { sessionId: string }).sessionId);
		expect(await local.send({ type: "get_state", sessionId: reopenedId })).toMatchObject({
			data: { holds: [], paused: false },
		});
		expect(
			await local.send({
				type: "admit_external_message",
				sessionId: reopenedId,
				deliveryId: "after-reopen",
				text: "after reopen",
				deliverAs: "followUp",
			}),
		).toMatchObject({ success: true, data: { kind: "started" } });
	});

	it("answers a drain that outlives waitMs typed, with the session still open and admitting again", async () => {
		const gate = gatedTool();
		const { sessionId, deliver, local } = await busySession(gate.extension);
		expect(await deliver("first")).toMatchObject({ data: { kind: "started" } });
		await gate.running;

		// Time is the behaviour under test here: the bound is what expires.
		const expired = await local.send({ ...GRACEFUL, sessionId, waitMs: 50 });
		expect(expired).toMatchObject({
			success: true,
			data: {
				outcome: "refused",
				reason: "turn_active",
				timed_out: true,
				open: true,
				admission: "reopened",
				turn: 1,
				dropped: { deliveries: [], user_messages: [] },
			},
		});
		expect(gate.seen.aborted).toBe(false);
		const state = await local.send({ type: "get_state", sessionId });
		expect(state).toMatchObject({ data: { isStreaming: true, holds: [] } });
		expect(await deliver("late")).toMatchObject({ success: true, data: { kind: "queued" } });
		gate.release();
	});

	it("is refused before anything is fenced when another blocker stands", async () => {
		const gate = gatedTool();
		const { sessionId, local } = await busySession(gate.extension);
		expect(await local.send({ ...GRACEFUL, sessionId, force: false })).toMatchObject({
			data: { outcome: "refused", reason: "attached" },
		});
		expect(
			await local.send({ type: "unload_session", sessionId, graceful: true, interrupt: true, force: true }),
		).toMatchObject({ data: { outcome: "refused", reason: "unsupported" } });
		expect(await local.send({ type: "get_state", sessionId })).toMatchObject({ data: { holds: [] } });
	});

	it("advertises unload_graceful", async () => {
		const gate = gatedTool();
		const { local } = await busySession(gate.extension);
		const info = await local.send({ type: "get_protocol_info" });
		expect((info.data as { capabilities: string[] }).capabilities).toContain("unload_graceful");
	});
});
