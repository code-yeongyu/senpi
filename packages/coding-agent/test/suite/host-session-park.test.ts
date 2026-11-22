import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { runHostSessionRequest } from "../../src/modes/rpc/host-session-runner.ts";
import { canonicalSessionPath } from "../../src/modes/rpc/session-path-key.ts";
import { JsonlPeer } from "../helpers/rpc-generation-support.ts";
import { cleanupHostSessionRigs, rig } from "./host-session-support.ts";

afterEach(cleanupHostSessionRigs, 120_000);

// #3073 review H1: the host parks an idle kept-alive session; its path and durable id must still reach it.
describe("host session references across a park", () => {
	it("reopens a parked session by path and by durable id, and keeps refusing unknown ones", async () => {
		const { target, opened, ref } = await rig(false, { SENPI_RPC_SESSION_IDLE_EVICTION_MS: "2000" });
		const sessionPath = String(opened.payload.sessionPath);
		const durableSessionId = String(opened.payload.durableSessionId);
		const observer = await JsonlPeer.connect(target.socket);
		try {
			const parked = (handle: string) =>
				observer.waitFor((record) => record.type === "session_parked" && record.sessionId === handle, 30_000);
			// A transcript is written with the first exchange; a session parked before it has nothing to resume.
			await runHostSessionRequest({ action: "prompt", target, ref, text: "park-me" });
			expect(
				await runHostSessionRequest({ action: "wait", target, ref, until: "done", timeoutMs: 20_000 }),
			).toMatchObject({ exitCode: 0 });
			await parked(ref);

			const byPath = await runHostSessionRequest({ action: "state", target, ref: sessionPath });
			expect(byPath, JSON.stringify(byPath.payload)).toMatchObject({
				exitCode: 0,
				payload: { action: "state", durableSessionId, state: { sessionId: durableSessionId } },
			});
			const reopenedHandle = String(byPath.payload.sessionId);
			expect(reopenedHandle).not.toBe(ref);

			await parked(reopenedHandle);
			expect(await runHostSessionRequest({ action: "state", target, ref: durableSessionId })).toMatchObject({
				exitCode: 0,
				payload: { durableSessionId, state: { sessionId: durableSessionId } },
			});

			expect(await runHostSessionRequest({ action: "state", target, ref: "no-such-durable-id" })).toMatchObject({
				exitCode: 3,
				payload: { reason: "unknown_session" },
			});
		} finally {
			observer.destroy();
		}
	}, 120_000);

	// senpi#3814 review H1: the CLI's parked reopen is its only hold, so unload must not count it as another client.
	it("unloads a parked session through the CLI", async () => {
		const { target, opened, ref } = await rig(false, { SENPI_RPC_SESSION_IDLE_EVICTION_MS: "2000" });
		const sessionPath = String(opened.payload.sessionPath);
		const observer = await JsonlPeer.connect(target.socket);
		try {
			const parked = observer.waitFor(
				(record) => record.type === "session_parked" && record.sessionId === ref,
				30_000,
			);
			await runHostSessionRequest({ action: "prompt", target, ref, text: "park-me" });
			expect(
				await runHostSessionRequest({ action: "wait", target, ref, until: "done", timeoutMs: 20_000 }),
			).toMatchObject({ exitCode: 0 });
			await parked;

			// The CLI's defaults for a bare `senpi host session unload <ref>`.
			const unloaded = await runHostSessionRequest({
				action: "unload",
				target,
				ref: sessionPath,
				interrupt: false,
				force: false,
				clearQueue: false,
				children: "refuse",
			});
			expect(unloaded, JSON.stringify(unloaded.payload)).toMatchObject({
				exitCode: 0,
				payload: { action: "unload", outcome: "unloaded" },
			});
		} finally {
			observer.destroy();
		}
	}, 120_000);

	// #3073 review H3: a durable id carried by a live session AND a parked transcript names two sessions.
	it("refuses a durable id that a live session and a parked transcript share", async () => {
		const { target, cwd } = await rig();
		const durableSessionId = randomUUID();
		const peer = await JsonlPeer.connect(target.socket);
		try {
			const open = async (id: string) => {
				const reply = await peer.request({ id, type: "open_session", cwd, durableSessionId });
				expect(reply, JSON.stringify(reply)).toMatchObject({ success: true });
				const data = reply.data as { sessionId: string; state: { sessionFile: string } };
				return { handle: data.sessionId, path: data.state.sessionFile };
			};
			const first = await open("open-1");
			// Drive the first turn on this one connection: its close must release the ONLY attachment to be final.
			const settled = peer.waitFor((record) => record.type === "agent_settled" && record.sessionId === first.handle);
			expect(
				await peer.request({
					id: "prompt-1",
					type: "prompt",
					sessionId: first.handle,
					message: "first transcript",
				}),
			).toMatchObject({ success: true });
			await settled;
			const closed = peer.waitFor((record) => record.type === "session_closed" && record.sessionId === first.handle);
			expect(await peer.request({ id: "close-1", type: "close_session", sessionId: first.handle })).toMatchObject({
				success: true,
			});
			// The id is free for a new transcript only once the first session has finished closing.
			await closed;
			const second = await open("open-2");
			expect(second.path).not.toBe(first.path);

			const byId = await runHostSessionRequest({ action: "state", target, ref: durableSessionId });
			expect(byId, JSON.stringify(byId.payload)).toMatchObject({
				exitCode: 3,
				payload: { reason: "ambiguous_session" },
			});
			const sorted = (paths: readonly string[]) => paths.map(canonicalSessionPath).sort();
			expect(sorted(byId.payload.candidates as string[])).toEqual(sorted([first.path, second.path]));
		} finally {
			peer.destroy();
		}
	}, 120_000);
});
