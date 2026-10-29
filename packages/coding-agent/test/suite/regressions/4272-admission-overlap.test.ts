import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";
import type { EventLease } from "../../../src/modes/rpc/compact-recovery-types.ts";

afterEach(() => vi.unstubAllEnvs());

it("T2/X04 every real leased suffix copy can page and release through its client admission", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const peer = host.client("peer");
	host.writer.setConnectionCapabilities("peer", ["compact_events"]);
	const sessionPath = join(host.cwd, "leased.jsonl");
	const opened = await peer.request({ type: "open_session", cwd: host.cwd, sessionPath, admissionId: "a" });
	await peer.request({ type: "open_session", cwd: host.cwd, sessionPath, admissionId: "b" });
	const pi = [...host.extensionApis.values()].at(-1) ?? expect.unreachable("no real extension bus");
	const delivered = peer.waitFor((frame) => frame.type === "message_end" && frame.eventLease !== undefined);
	await pi.sendMessage({ customType: "admission", content: "z".repeat(300_000), display: true });
	await delivered;
	await host.writer.flush();
	const envelopes = peer.inbox.filter((frame) => frame.eventLease !== undefined);
	for (const frame of envelopes)
		expect(frame).toMatchObject({ generation: 1, admissionId: expect.stringMatching(/^[ab]$/) });
	const end = envelopes.find((frame) => frame.type === "message_end") ?? expect.unreachable();
	const lease = end.eventLease as EventLease;
	for (const admissionId of ["a", "b"]) {
		const page = await peer.request({
			type: "get_recovery_page",
			sessionId: opened.sessionId,
			admissionId,
			lease,
			componentRef: "record",
			requestId: `lease-${admissionId}`,
		});
		expect(page).toMatchObject({ success: true, sessionId: opened.sessionId, admissionId, generation: 1 });
	}
	const unique = new Map(envelopes.map((frame) => [(frame.eventLease as EventLease).id, frame.eventLease]));
	for (const eventLease of unique.values())
		for (const admissionId of ["a", "b"])
			expect(
				await peer.request({
					type: "release_recovery",
					sessionId: opened.sessionId,
					admissionId,
					lease: eventLease,
				}),
			).toMatchObject({ success: true });
	expect(host.writer.recoveryEvents?.status().open).toBe(0);
}, 120_000);

it("T2/T5 overlapping ordinary admissions share a cut and a surviving route can page it", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const peer = host.client("peer");
	const sessionPath = join(host.cwd, "shared.jsonl");
	const a = await peer.request({ type: "open_session", cwd: host.cwd, sessionPath, admissionId: "a" });
	const b = await peer.request({ type: "open_session", cwd: host.cwd, sessionPath, admissionId: "b" });
	expect(b).toMatchObject({ sessionId: a.sessionId, generation: 1, admissionId: "b" });
	const first = dataOf(a).recovery as { token: string };
	expect(dataOf(b).recovery).toEqual(first);
	const sessionId = String(a.sessionId);
	const socketEpoch = host.writer.socketEpochOf("peer") ?? "";
	host.writer.recoveryCheckpoints.retireRoute({ socketEpoch, sessionId }, "a");
	const page = await peer.request({
		type: "get_recovery_page",
		sessionId,
		token: first.token,
		admissionId: "b",
		componentRef: "manifest",
		requestId: "b-page",
	});
	expect(page).toMatchObject({ success: true, sessionId, admissionId: "b", generation: 1 });
	expect(host.writer.recoveryCheckpoints.status().open).toBe(1);
	host.writer.recoveryCheckpoints.retireRoute({ socketEpoch, sessionId }, "b");
	expect(host.writer.recoveryCheckpoints.status().open).toBe(0);
}, 120_000);

it("T2 every suffix and final close instance keeps both S08 routes after reset and stream retirement", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const peer = host.client("peer");
	const sessionPath = join(host.cwd, "terminal.jsonl");
	const a = await peer.request({ type: "open_session", cwd: host.cwd, sessionPath, admissionId: "a" });
	await peer.request({ type: "open_session", cwd: host.cwd, sessionPath, admissionId: "b" });
	const sessionId = String(a.sessionId);
	const reset = await peer.request({ type: "reset_stream", sessionId, admissionId: "b" });
	const from = peer.inbox.length;
	for (const type of ["agent_idle", "extension_ui_request", "agent_event", "event_lease"])
		host.writer.enqueue(sessionId, { type });
	await peer.request({ type: "close_session", sessionId });
	await peer.request({ type: "close_session", sessionId });
	await host.writer.flush();
	const frames = peer.inbox.slice(from).filter((frame) => frame.sessionId === sessionId);
	expect(frames.some((frame) => frame.type === "session_closed")).toBe(true);
	for (const frame of frames) {
		expect(["a", "b"], JSON.stringify(frame)).toContain(frame.admissionId);
		expect(frame.generation, JSON.stringify(frame)).toBe(reset.generation);
	}
	for (const type of ["agent_idle", "extension_ui_request", "agent_event", "event_lease", "session_closed"])
		expect(
			frames
				.filter((frame) => frame.type === type)
				.map((frame) => frame.admissionId)
				.sort(),
		).toEqual(["a", "b"]);
	expect(frames.filter((frame) => frame.command === "close_session")).toHaveLength(4);
}, 120_000);
