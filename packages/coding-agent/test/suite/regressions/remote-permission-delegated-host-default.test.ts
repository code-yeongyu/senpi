import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DelegatedHost } from "../rpc-delegated-host-support.ts";
import { ASKED, FrameLog, open, permissionHost, probeCalls, remotePeer } from "../rpc-delegated-permission-support.ts";

// Remote approval-mode work (tracked privately): a session a remote device drives with no named approval mode ran
// every tool call on the host's own default (full-access), so nothing the remote device started ever asked.

let host: DelegatedHost | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
}, 60_000);

describe("#6189 the host default, a recorded mode and claims a client makes", () => {
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
			// `read` runs under the host default too: the enforced preset is what tells the recorded mode was restored.
			expect((await remote.send({ type: "get_state", sessionId })).data).toMatchObject({
				effectivePermissionPreset: "read-only",
			});
		},
		120_000,
	);

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

	it("keeps the embedder's host default on a preset-less reattach, so a remote turn still asks", async () => {
		host = await permissionHost([], { embedderPreset: true });
		const remote = await remotePeer(host);
		const log = new FrameLog(remote);
		const sessionPath = join(host.cwd, "reattached.jsonl");
		await open(remote, { sessionPath });
		const { sessionId } = await open(remote, { sessionPath });
		expect((await remote.send({ type: "get_state", sessionId })).data).toMatchObject({
			permissionPresetSource: "host_default",
		});
		const [call] = await probeCalls(log, { log, peer: remote }, sessionId, {
			count: 1,
			answer: "Deny",
			start: () => remote.send({ type: "prompt", sessionId, message: "go" }),
		});
		expect(call).toEqual({ asked: ASKED, ran: false });
	}, 120_000);

	it("keeps refusing every gated call under an invalid --permission-preset, remote work included", async () => {
		host = await permissionHost([], { hostArgs: ["--permission-preset", "full-acess"] });
		const remote = await remotePeer(host);
		const log = new FrameLog(remote);
		const { sessionId } = await open(remote);
		const [call] = await probeCalls(log, { log, peer: remote }, sessionId, {
			count: 1,
			answer: "Deny",
			start: () => remote.send({ type: "prompt", sessionId, message: "go" }),
		});
		expect(call).toEqual({ asked: [], ran: false });
	}, 120_000);
});
