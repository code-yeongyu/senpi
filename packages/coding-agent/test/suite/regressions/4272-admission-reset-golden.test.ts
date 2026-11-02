import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { statusHost } from "../rpc-session-status-support.ts";
import { compareAdmissionGoldens } from "./4272-admission-golden-support.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

async function admissionRows(root: string): Promise<number> {
	const epochs = (await readdir(root)).filter((name) => name.startsWith("senpi-admissions-"));
	const counts = await Promise.all(epochs.map(async (epoch) => (await readdir(join(root, epoch))).length));
	return counts.reduce((sum, count) => sum + count, 0);
}

// #4272 R3 C4.4: reset_stream is the explicit reset of an existing admission; it changes generation and adds no hold.
it("T2 golden i: reset_stream re-baselines the same admission at a new generation without a second hold", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const root = await mkdtemp(join(tmpdir(), "senpi-admission-reset-golden-"));
	vi.stubEnv("TMPDIR", root);
	vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-29T00:00:00.000Z") });
	try {
		await using host = await statusHost();
		const peer = host.client("peer");
		const foreign = host.client("foreign");
		const sessionPath = join(host.cwd, "golden.jsonl");
		const opened = await peer.request({ type: "open_session", cwd: host.cwd, sessionPath, admissionId: "golden-i" });
		const sessionId = String(opened.sessionId);
		const baseline = await peer.waitFor(
			(frame) => frame.type === "recovery_manifest" && frame.admissionId === "golden-i",
		);
		host.writer.enqueue(sessionId, { type: "agent_idle" });
		await host.writer.flush();
		const before = peer.inbox.filter((frame) => frame.type === "agent_idle" && frame.sessionId === sessionId);
		expect(before).toEqual([{ type: "agent_idle", sessionId, admissionId: "golden-i", generation: 1 }]);

		const checkpoints = host.writer.recoveryCheckpoints;
		const caller = { socketEpoch: host.writer.socketEpochOf("peer") ?? "", sessionId };
		const held = {
			rows: await admissionRows(root),
			open: checkpoints.status().open,
			streams: checkpoints.status().streams,
			routes: checkpoints.stream(caller)?.routes,
			sessions: host.core.router.sessionCount,
		};
		expect(held).toEqual({ rows: 1, open: 1, streams: 1, routes: ["golden-i"], sessions: 1 });
		expect(checkpoints.stream(caller)?.generation).toBe(1);

		const from = peer.inbox.length;
		const reset = await peer.request({ type: "reset_stream", sessionId, admissionId: "golden-i" });
		host.writer.enqueue(sessionId, { type: "agent_idle" });
		await host.writer.flush();
		expect(reset).toMatchObject({ success: true, sessionId, admissionId: "golden-i", generation: 2 });
		const recovery = (reset.data as { recovery: { token: string; componentRef: string } }).recovery;
		expect(recovery.componentRef).toBe("manifest");
		expect(recovery.token).not.toBe(baseline.token);
		// The reset answer leads; its baseline precedes every later compact frame of the admission, all at generation 2.
		const after = peer.inbox.slice(from).filter((frame) => frame.sessionId === sessionId);
		expect(after.map((frame) => frame.type)).toEqual(["response", "recovery_manifest", "agent_idle"]);
		for (const frame of after) expect(frame).toMatchObject({ admissionId: "golden-i", generation: 2 });
		expect(after[1]).toMatchObject({ token: recovery.token, componentRef: "manifest" });
		// Same admission, same hold: no second index row, checkpoint, stream, route or session; the old cut is reclaimed.
		expect({
			rows: await admissionRows(root),
			open: checkpoints.status().open,
			streams: checkpoints.status().streams,
			routes: checkpoints.stream(caller)?.routes,
			sessions: host.core.router.sessionCount,
		}).toEqual(held);
		expect(checkpoints.stream(caller)?.generation).toBe(2);
		expect(checkpoints.status().reclaimed).toBe(1);
		const page = await peer.request({
			type: "get_recovery_page",
			sessionId,
			admissionId: "golden-i",
			token: recovery.token,
			componentRef: "manifest",
			requestId: "golden-i-page",
		});
		expect(page).toMatchObject({ success: true, sessionId, admissionId: "golden-i", generation: 2 });

		// An admission this connection does not hold, never opened or held by another socket, is unknown_admission.
		await foreign.request({ type: "open_session", cwd: host.cwd, sessionPath, admissionId: "golden-i-foreign" });
		const unheld = await peer.request({ type: "reset_stream", sessionId, admissionId: "golden-i-unheld" });
		const foreignHeld = await peer.request({ type: "reset_stream", sessionId, admissionId: "golden-i-foreign" });
		for (const [refusal, admissionId] of [
			[unheld, "golden-i-unheld"],
			[foreignHeld, "golden-i-foreign"],
		] as const)
			expect(refusal).toMatchObject({ success: false, code: "unknown_admission", admissionId });
		expect(checkpoints.stream(caller)).toMatchObject({ generation: 2, routes: ["golden-i"] });

		await compareAdmissionGoldens(
			{
				"i-reset-stream.json": {
					before: { baseline, frames: before },
					request: JSON.parse(peer.sent[1] ?? "") as unknown,
					reset,
					after,
					page,
					refusals: {
						unheld: { request: JSON.parse(peer.sent[3] ?? "") as unknown, answer: unheld },
						foreign: { request: JSON.parse(peer.sent[4] ?? "") as unknown, answer: foreignHeld },
					},
				},
			},
			dirname(host.cwd),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 600_000);
