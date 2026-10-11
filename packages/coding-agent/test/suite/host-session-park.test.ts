import { afterEach, describe, expect, it } from "vitest";
import { runHostSessionRequest } from "../../src/modes/rpc/host-session-runner.ts";
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
});
