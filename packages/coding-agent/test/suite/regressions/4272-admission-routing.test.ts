import { afterEach, expect, it, vi } from "vitest";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

// #4272 T2, RULING-85 Q3: the pre-answer lifecycle event and later suffix must be
// independently routable. The original admissions tests only inspect answer/manifest/pages.
it("T2 every open frame, including a suffix before its answer, carries the S08 route", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const peer = host.client("peer");
	const answer = await peer.request({ type: "open_session", cwd: host.cwd, admissionId: "route-all" });
	const sessionId = String(answer.sessionId);
	host.writer.enqueue(sessionId, { type: "agent_idle" });
	await host.writer.flush();
	const frames = peer.inbox.filter((frame) => frame.sessionId === sessionId);
	expect(frames.map((frame) => frame.type)).toContain("recovery_manifest");
	for (const frame of frames)
		expect(frame, String(frame.type)).toMatchObject({ admissionId: "route-all", generation: 1 });
	const early = frames.find((frame) => frame.type === "session_opened");
	expect(early).toBeDefined();
	expect(peer.inbox.indexOf(early ?? answer)).toBeLessThan(peer.inbox.indexOf(answer));
}, 120_000);

// #4272 T5, RULING-42: reset advances the shared S08 generation and never
// invokes open/attach. A stale token must not silently read the current root.
it("T5 reset advances the admitted stream without acquiring another hold", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const peer = host.client("peer");
	const opened = await peer.request({ type: "open_session", cwd: host.cwd, admissionId: "reset-one" });
	const answer = await peer.request({
		type: "reset_stream",
		sessionId: opened.sessionId,
		admissionId: "reset-one",
	});
	expect(answer).toMatchObject({ success: true, admissionId: "reset-one", generation: 2 });
	expect(dataOf(await peer.request({ type: "list_sessions" })).sessions).toEqual([
		expect.objectContaining({ attachments: 1 }),
	]);
}, 120_000);
