import { afterEach, describe, expect, it } from "vitest";
import { readDecisionPresetOverride } from "../../../src/core/extensions/builtin/permission-system/preset-registry.ts";
import { bindDecisionPreset, releaseDecisionPreset } from "../../../src/core/permission-decision.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import type { DelegatedHost } from "../rpc-delegated-host-support.ts";
import { ASKED, FrameLog, open, permissionHost, probeCalls, remotePeer } from "../rpc-delegated-permission-support.ts";

// Remote approval-mode work (tracked privately): child sessions follow their live parent's mode, so a remote-driven
// parent cannot hand its work to a child that runs on the host default.

let host: DelegatedHost | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
}, 60_000);

describe("#6189 child sessions and their live parent", () => {
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
