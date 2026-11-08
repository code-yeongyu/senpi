import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import { noteDelegatedRecord } from "../../../src/modes/rpc/delegated-drive-origin.ts";
import { RPC_METHOD_CLASS } from "../../../src/modes/rpc/method-classes.ts";
import { attach, type DelegatedHost } from "../rpc-delegated-host-support.ts";
import {
	ASKED,
	FrameLog,
	open,
	PROBE_TEXT,
	permissionHost,
	probeCalls,
	remotePeer,
} from "../rpc-delegated-permission-support.ts";

// Remote approval-mode work (tracked privately): a session a remote device drives with no named approval mode ran
// every tool call on the host's own default (full-access), so nothing the remote device started ever asked.

let host: DelegatedHost | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
}, 60_000);

let engineFollowUpArmed = false;
const engineFollowUp: ExtensionFactory = (pi) => {
	pi.on("agent_end", () => {
		if (!engineFollowUpArmed) return;
		engineFollowUpArmed = false;
		pi.sendUserMessage("engine turn", { deliverAs: "followUp" });
	});
};

describe("#6189 the origin of a turn on a session with no client-named mode", () => {
	it("asks for every gated call a remote device's prompt starts; Deny keeps the probe unread", async () => {
		host = await permissionHost();
		const remote = await remotePeer(host);
		const log = new FrameLog(remote);
		const { sessionId } = await open(remote);

		const [call] = await probeCalls(log, { log, peer: remote }, sessionId, {
			count: 1,
			answer: "Deny",
			start: () => remote.send({ type: "prompt", sessionId, message: "go" }),
		});
		expect(call).toEqual({ asked: ASKED, ran: false });
	}, 120_000);

	it("keeps the host default for a local connection's prompt", async () => {
		host = await permissionHost();
		const local = await host.proven();
		const log = new FrameLog(local);
		const { sessionId } = await open(local);

		const [call] = await probeCalls(log, { log, peer: local }, sessionId, {
			count: 1,
			answer: "Deny",
			start: () => local.send({ type: "prompt", sessionId, message: "go" }),
		});
		expect(call).toEqual({ asked: [], ran: true });
	}, 120_000);

	it("runs a local prompt on the host default on a remote-driven session, but asks for engine-started work", async () => {
		host = await permissionHost([engineFollowUp]);
		const remote = await remotePeer(host);
		const remoteLog = new FrameLog(remote);
		const session = await open(remote);
		const [remoteCall] = await probeCalls(remoteLog, { log: remoteLog, peer: remote }, session.sessionId, {
			count: 1,
			answer: "Deny",
			start: () => remote.send({ type: "prompt", sessionId: session.sessionId, message: "go" }),
		});
		expect(remoteCall).toEqual({ asked: ASKED, ran: false });

		const local = await host.proven();
		const localLog = new FrameLog(local);
		const attached = await local.send({
			type: "attach_session",
			sessionId: session.sessionId,
			durableSessionId: session.durableSessionId,
		});
		expect(attached).toMatchObject({ success: true });
		engineFollowUpArmed = true;
		const [localCall, engineCall] = await probeCalls(localLog, { log: localLog, peer: local }, session.sessionId, {
			count: 2,
			answer: "Deny",
			start: () => local.send({ type: "prompt", sessionId: session.sessionId, message: "go" }),
		});
		expect(localCall).toEqual({ asked: [], ran: true });
		expect(engineCall).toEqual({ asked: ASKED, ran: false });
	}, 120_000);

	it("never overrides a mode the remote client named", async () => {
		host = await permissionHost();
		const remote = await remotePeer(host);
		const log = new FrameLog(remote);
		const { sessionId } = await open(remote, { permissionPreset: "full-access" });

		const [call] = await probeCalls(log, { log, peer: remote }, sessionId, {
			count: 1,
			answer: "Deny",
			start: () => remote.send({ type: "prompt", sessionId, message: "go" }),
		});
		expect(call).toEqual({ asked: [], ran: true });
	}, 120_000);

	it("applies a mid-turn mode change to the running turn's next gated call", async () => {
		host = await permissionHost();
		const gate = Promise.withResolvers<void>();
		host.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "probe.txt" }, { id: "probe-first" })], {
				stopReason: "toolUse",
			}),
			async () => {
				await gate.promise;
				return fauxAssistantMessage([fauxToolCall("read", { path: "probe.txt" }, { id: "probe-second" })], {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("done"),
		]);
		const local = await host.proven();
		const log = new FrameLog(local);
		const { sessionId } = await open(local, { permissionPreset: "full-access" });
		const ended = (id: string) =>
			log.next((record) => record.type === "tool_execution_end" && record.toolCallId === id);
		const asked = log.next(
			(record) =>
				record.type === "extension_ui_request" && record.method === "select" && record.sessionId === sessionId,
		);

		await local.send({ type: "prompt", sessionId, message: "go" });
		expect(JSON.stringify(await ended("probe-first"))).toContain(PROBE_TEXT);
		expect(await local.send({ type: "set_permission_preset", sessionId, permissionPreset: "ask" })).toMatchObject({
			success: true,
		});
		gate.resolve();
		const dialog = await asked;
		expect(String(dialog.title).split("\n")[0]).toBe(ASKED[0]);
		local.socket.write(
			`${JSON.stringify({ type: "extension_ui_response", sessionId, id: dialog.id, value: "Deny" })}\n`,
		);
		expect(JSON.stringify(await ended("probe-second"))).not.toContain(PROBE_TEXT);
	}, 120_000);

	it("asks when a remote device continues a session it never prompted (continue_from_leaf)", async () => {
		host = await permissionHost();
		const local = await host.proven();
		const localLog = new FrameLog(local);
		const session = await open(local);
		const [localCall] = await probeCalls(localLog, { log: localLog, peer: local }, session.sessionId, {
			count: 1,
			answer: "Deny",
			start: () => local.send({ type: "prompt", sessionId: session.sessionId, message: "go" }),
		});
		expect(localCall).toEqual({ asked: [], ran: true });

		const remote = await remotePeer(host);
		const remoteLog = new FrameLog(remote);
		expect(await remote.send(attach(session))).toMatchObject({ success: true });
		const [remoteCall] = await probeCalls(remoteLog, { log: remoteLog, peer: remote }, session.sessionId, {
			count: 1,
			answer: "Deny",
			start: () => remote.send({ type: "continue_from_leaf", sessionId: session.sessionId }),
		});
		expect(remoteCall).toEqual({ asked: ASKED, ran: false });
	}, 120_000);

	it("asks for a turn a remote follow_up starts on an idle session", async () => {
		host = await permissionHost();
		const remote = await remotePeer(host);
		const log = new FrameLog(remote);
		const { sessionId } = await open(remote);
		const [call] = await probeCalls(log, { log, peer: remote }, sessionId, {
			count: 1,
			answer: "Deny",
			start: () => remote.send({ type: "follow_up", sessionId, message: "go", whenIdle: "start" }),
		});
		expect(call).toEqual({ asked: ASKED, ran: false });
	}, 120_000);

	it("marks a session remote-driven when a remote device compacts it, so engine-started work then asks", async () => {
		host = await permissionHost([engineFollowUp]);
		const local = await host.proven();
		const localLog = new FrameLog(local);
		const session = await open(local);
		const remote = await remotePeer(host);
		expect(await remote.send(attach(session))).toMatchObject({ success: true });
		await remote.send({ type: "compact", sessionId: session.sessionId });

		engineFollowUpArmed = true;
		const [localCall, engineCall] = await probeCalls(localLog, { log: localLog, peer: local }, session.sessionId, {
			count: 2,
			answer: "Deny",
			start: () => local.send({ type: "prompt", sessionId: session.sessionId, message: "go" }),
		});
		expect(localCall).toEqual({ asked: [], ran: true });
		expect(engineCall).toEqual({ asked: ASKED, ran: false });
	}, 120_000);

	it("marks the session for every record the method-class table lets act on its work, and for no other", () => {
		const acting: ReadonlySet<string> = new Set(["drive", "device_admin"]);
		const staticRows = Object.entries(RPC_METHOD_CLASS).flatMap(([type, entry]) =>
			typeof entry === "string" ? [{ type, methodClass: entry }] : [],
		);
		expect(staticRows.filter((row) => row.methodClass === "drive").length).toBeGreaterThan(20);
		const marks = (type: string, origin: "local" | "delegated") => {
			const entries: SessionEntry[] = [];
			const sessionManager = {
				getEntries: () => entries,
				appendCustomEntry: (customType: string) => {
					entries.push({ type: "custom", customType, id: String(entries.length), parentId: null, timestamp: "" });
					return String(entries.length);
				},
			};
			noteDelegatedRecord({ type }, origin, sessionManager);
			return entries.length;
		};
		const outcome = staticRows.map(({ type }) => ({
			type,
			delegated: marks(type, "delegated"),
			local: marks(type, "local"),
		}));
		expect(outcome).toEqual(
			staticRows.map(({ type, methodClass }) => ({ type, delegated: acting.has(methodClass) ? 1 : 0, local: 0 })),
		);
	});
});
