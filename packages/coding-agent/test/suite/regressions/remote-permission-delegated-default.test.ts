import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { bindDecisionPreset, releaseDecisionPreset } from "../../../src/core/permission-decision.ts";
import { readDecisionPresetOverride } from "../../../src/core/extensions/builtin/permission-system/preset-registry.ts";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { attach, type DelegatedHost, declare } from "../rpc-delegated-host-support.ts";
import {
	FrameLog,
	open,
	PROBE_TEXT,
	permissionHost,
	probeCalls,
	remotePeer,
} from "../rpc-delegated-permission-support.ts";

// Remote approval-mode work (tracked privately): a session a remote device drives with no named approval mode ran
// every tool call on the host's own default (full-access), so nothing the remote device started ever asked.

const ASKED = ["Permission required: read"];
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

describe("#6189 delegated-origin turns on a session with no client-named mode", () => {
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

	it.each([false, true])(
		"restores a recorded mode for a remote device's preset-less reopen (embedder preset: %s)",
		async (embedderPreset) => {
			host = await permissionHost([], { embedderPreset });
			const remote = await remotePeer(host);
			const log = new FrameLog(remote);
			const sessionPath = join(host.cwd, "recorded.jsonl");
			const first = await open(remote, { sessionPath, permissionPreset: "read-only" });
			const [named] = await probeCalls(log, { log, peer: remote }, first.sessionId, {
				count: 1,
				answer: "Deny",
				start: () => remote.send({ type: "prompt", sessionId: first.sessionId, message: "go" }),
			});
			expect(named).toEqual({ asked: [], ran: true });
			expect(await remote.send({ type: "close_session", sessionId: first.sessionId })).toMatchObject({
				success: true,
			});

			const { sessionId } = await open(remote, { sessionPath });
			const [call] = await probeCalls(log, { log, peer: remote }, sessionId, {
				count: 1,
				answer: "Deny",
				start: () => remote.send({ type: "prompt", sessionId, message: "go" }),
			});
			expect(call).toEqual({ asked: [], ran: true });
		},
		120_000,
	);

	it("makes a local child of a remote-driven parent turn ask too", async () => {
		host = await permissionHost();
		const remote = await remotePeer(host);
		const remoteLog = new FrameLog(remote);
		const parent = await open(remote);
		const [parentCall] = await probeCalls(remoteLog, { log: remoteLog, peer: remote }, parent.sessionId, {
			count: 1,
			answer: "Deny",
			start: () => remote.send({ type: "prompt", sessionId: parent.sessionId, message: "go" }),
		});
		expect(parentCall).toEqual({ asked: ASKED, ran: false });

		const local = await host.proven();
		const localLog = new FrameLog(local);
		const spawnedBy = {
			parentSessionId: parent.durableSessionId,
			rootSessionId: parent.durableSessionId,
			taskId: "x6189-task",
		};
		const child = await open(local, { spawnedBy });
		const [childCall] = await probeCalls(localLog, { log: localLog, peer: local }, child.sessionId, {
			count: 1,
			answer: "Deny",
			start: () => local.send({ type: "prompt", sessionId: child.sessionId, message: "go" }),
		});
		expect(childCall).toEqual({ asked: ASKED, ran: false });
	}, 120_000);

	it("moves an inherited child with its parent's live mode change", async () => {
		host = await permissionHost();
		const local = await host.proven();
		const log = new FrameLog(local);
		const parent = await open(local, { permissionPreset: "full-access" });
		const spawnedBy = {
			parentSessionId: parent.durableSessionId,
			rootSessionId: parent.durableSessionId,
			taskId: "x6189-follow",
		};
		const child = await open(local, { spawnedBy });
		const prompt = () => local.send({ type: "prompt", sessionId: child.sessionId, message: "go" });
		const [before] = await probeCalls(log, { log, peer: local }, child.sessionId, {
			count: 1,
			answer: "Deny",
			start: prompt,
		});
		expect(before).toEqual({ asked: [], ran: true });

		expect(
			await local.send({ type: "set_permission_preset", sessionId: parent.sessionId, permissionPreset: "ask" }),
		).toMatchObject({ success: true });
		const [after] = await probeCalls(log, { log, peer: local }, child.sessionId, {
			count: 1,
			answer: "Deny",
			start: prompt,
		});
		expect(after).toEqual({ asked: ASKED, ran: false });
	}, 120_000);

	it("binds the same rule to an in-process child created through createAgentSession", async () => {
		host = await permissionHost();
		const remote = await remotePeer(host);
		const remoteLog = new FrameLog(remote);
		const driven = await open(remote);
		await probeCalls(remoteLog, { log: remoteLog, peer: remote }, driven.sessionId, {
			count: 1,
			answer: "Deny",
			start: () => remote.send({ type: "prompt", sessionId: driven.sessionId, message: "go" }),
		});
		const local = await host.proven();
		const localLog = new FrameLog(local);
		const quiet = await open(local);
		await probeCalls(localLog, { log: localLog, peer: local }, quiet.sessionId, {
			count: 1,
			answer: "Deny",
			start: () => local.send({ type: "prompt", sessionId: quiet.sessionId, message: "go" }),
		});

		const childOf = async (parentSessionId: string) => {
			const sessionManager = SessionManager.inMemory(host?.cwd, {
				spawnedBy: { parentSessionId, rootSessionId: parentSessionId, taskId: "x6189-in-process" },
			});
			const { session } = await createAgentSession({
				cwd: host?.cwd,
				settingsManager: SettingsManager.inMemory(),
				sessionManager,
				resourceLoader: createTestResourceLoader({ extensionsResult: await createTestExtensionsResult([]) }),
			});
			return session;
		};
		const remoteChild = await childOf(driven.durableSessionId);
		const localChild = await childOf(quiet.durableSessionId);
		try {
			expect(readDecisionPresetOverride(remoteChild.sessionManager)).toBe("ask");
			expect(readDecisionPresetOverride(localChild.sessionManager)).toBeUndefined();
		} finally {
			remoteChild.dispose();
			localChild.dispose();
		}
	}, 120_000);

	it("treats an embedder's host-level preset as the host default, so a remote turn still asks", async () => {
		host = await permissionHost([], { embedderPreset: true });
		const remote = await remotePeer(host);
		const log = new FrameLog(remote);
		const opened = await remote.send({ type: "open_session" });
		expect(opened.data).toMatchObject({ permissionPreset: "full-access", permissionPresetSource: "host_default" });
		const sessionId = String((opened.data as { sessionId: string }).sessionId);

		const [call] = await probeCalls(log, { log, peer: remote }, sessionId, {
			count: 1,
			answer: "Deny",
			start: () => remote.send({ type: "prompt", sessionId, message: "go" }),
		});
		expect(call).toEqual({ asked: ASKED, ran: false });
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

	it("keeps a remote turn's approval pending after its connection drops, for an answer-holding device to settle", async () => {
		host = await permissionHost();
		const raiser = await remotePeer(host);
		const raiserLog = new FrameLog(raiser);
		const session = await open(raiser);
		const raised = raiserLog.next(
			(record) =>
				record.type === "extension_ui_request" &&
				record.method === "select" &&
				record.sessionId === session.sessionId,
		);
		await raiser.send({ type: "prompt", sessionId: session.sessionId, message: "go" });
		const dialog = await raised;
		await host.drop(raiser);

		const other = await host.proven();
		expect(
			await declare(other, ["observe", "drive", "thread", "answer"], {
				deviceId: "x6189-other",
				deviceName: "Other",
			}),
		).toMatchObject({ success: true });
		const otherLog = new FrameLog(other);
		expect(await other.send(attach(session))).toMatchObject({ success: true });
		const state = await other.send({ type: "get_state", sessionId: session.sessionId });
		const pending = (state.data as { pendingDialogs?: Array<{ id: unknown }> }).pendingDialogs ?? [];
		expect(pending.map((entry) => entry.id)).toContain(dialog.id);

		const viewer = await host.proven();
		expect(
			await declare(viewer, ["observe", "thread"], { deviceId: "x6189-viewer", deviceName: "Viewer" }),
		).toMatchObject({ success: true });
		expect(await viewer.send(attach(session))).toMatchObject({ success: true });
		expect(
			await viewer.send({
				type: "extension_ui_response",
				sessionId: session.sessionId,
				id: dialog.id,
				value: "Allow once",
			}),
		).toMatchObject({ success: false, errorCode: "delegation_not_granted" });

		const ended = otherLog.next(
			(record) => record.type === "tool_execution_end" && record.sessionId === session.sessionId,
		);
		other.socket.write(
			`${JSON.stringify({ type: "extension_ui_response", sessionId: session.sessionId, id: dialog.id, value: "Deny" })}\n`,
		);
		expect(JSON.stringify(await ended)).not.toContain(PROBE_TEXT);
	}, 120_000);

	it.each([
		["a made-up parent on an embedder-preset host", { embedderPreset: true }, false],
		["a real live parent the remote device does not own", { embedderPreset: false }, true],
	] as const)(
		"keeps a remote open that names spawnedBy on the delegated default: %s",
		async (_label, options, realParent) => {
			host = await permissionHost([], options);
			let parentSessionId = "x6189-made-up-parent";
			if (realParent) {
				const local = await host.proven();
				parentSessionId = (await open(local, { permissionPreset: "full-access" })).durableSessionId;
			}
			const remote = await remotePeer(host);
			const log = new FrameLog(remote);
			const spawnedBy = { parentSessionId, rootSessionId: parentSessionId, taskId: "x6189-forged" };
			const { sessionId } = await open(remote, { spawnedBy });
			const [call] = await probeCalls(log, { log, peer: remote }, sessionId, {
				count: 1,
				answer: "Deny",
				start: () => remote.send({ type: "prompt", sessionId, message: "go" }),
			});
			expect(call).toEqual({ asked: ASKED, ran: false });
		},
		120_000,
	);

	it("asks on a spawnedBy loop instead of recursing, and stops following a released parent", () => {
		const stub = (id: string, parentSessionId: string | undefined, named?: string) => {
			const sessionManager = {
				getSessionId: () => id,
				getEntries: () => [],
				getHeader: () => ({
					type: "session" as const,
					id,
					timestamp: "",
					cwd: "",
					...(parentSessionId === undefined
						? {}
						: { spawnedBy: { parentSessionId, rootSessionId: parentSessionId, taskId: "x6189-loop" } }),
				}),
			};
			bindDecisionPreset({
				sessionManager,
				namedPreset: () => named,
				launchFlagNamed: () => false,
				recordedPreset: () => undefined,
			});
			return sessionManager;
		};
		const looped = stub("x6189-self", "x6189-self");
		expect(readDecisionPresetOverride(looped)).toBe("ask");

		const parent = stub("x6189-parent", undefined, "full-access");
		const child = stub("x6189-child", "x6189-parent");
		expect(readDecisionPresetOverride(child)).toBe("full-access");
		releaseDecisionPreset(parent);
		expect(readDecisionPresetOverride(child)).toBe("ask");
	});
});
