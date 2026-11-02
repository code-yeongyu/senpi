import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { dataOf, type RawClient, statusHost } from "../rpc-session-status-support.ts";

afterEach(() => vi.unstubAllEnvs());

// RULING-118 (#5274): a detach retires the socket's route to the session after its reply is tagged, so a long-lived
// socket visiting many distinct live sessions never runs out of admissions and hears nothing more from a detached one.
const VISITS = 300;
// The socket's route cap (127): a detach that left its route in place would be refused from this visit on.
const ROUTE_CAP = 127;

async function compactHost() {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	return statusHost();
}

const openRetained = (peer: RawClient, cwd: string, file: string, admissionId: string) =>
	peer.request({ type: "open_session", cwd, sessionPath: join(cwd, file), admissionId, retain_on_disconnect: true });

it("RULING-118 a socket that attaches and detaches 300 distinct live sessions (past the 127-route cap) is never refused", async () => {
	await using host = await compactHost();
	const peer = host.client("peer");
	const visited: string[] = [];
	for (let n = 0; n < VISITS; n++) {
		const admissionId = `visit-${n}`;
		const opened = await openRetained(peer, host.cwd, `visit-${n}.jsonl`, admissionId);
		if (opened.success !== true) expect(opened, `visit ${n}`).toMatchObject({ success: true });
		const sessionId = String(opened.sessionId);
		const released = await peer.request({ type: "release_attachment", sessionId, admissionId });
		if (released.success !== true) expect(released, `detach ${n}`).toMatchObject({ success: true });
		visited.push(sessionId);
		if (n === VISITS - 1) {
			// Past the cap: the detached admission routes nothing more (lifecycle broadcasts such as agent_idle reach every
			// socket untagged by design, BROADCAST_LIFECYCLE_RECORDS, so only admission-tagged records count).
			await host.writer.flush();
			const from = peer.inbox.length;
			host.writer.enqueue(sessionId, { type: "agent_event" });
			host.writer.enqueue(sessionId, { type: "agent_idle" });
			await host.writer.flush();
			const routed = peer.inbox
				.slice(from)
				.filter((frame) => frame.sessionId === sessionId && frame.admissionId !== undefined);
			expect(routed, "routed records after the last detach").toEqual([]);
			expect(host.writer.routesAdmission(host.writer.socketEpochOf("peer") ?? "", admissionId)).toBe(false);
		}
	}
	expect(visited.slice(ROUTE_CAP)).toHaveLength(VISITS - ROUTE_CAP);
	const listed = dataOf(await peer.request({ type: "list_sessions" })).sessions;
	if (!Array.isArray(listed)) throw new Error("missing session list");
	const live = new Set(listed.map((row: { sessionId?: unknown }) => row.sessionId));
	expect(visited.filter((sessionId) => !live.has(sessionId))).toEqual([]);
}, 600_000);

it("RULING-118 after a detach the peer receives no further records for that session", async () => {
	await using host = await compactHost();
	const peer = host.client("peer");
	const opened = await openRetained(peer, host.cwd, "detached.jsonl", "d");
	const sessionId = String(opened.sessionId);
	const released = await peer.request({ type: "release_attachment", sessionId, admissionId: "d" });
	expect(released).toMatchObject({ success: true });
	await host.writer.flush();
	const from = peer.inbox.length;
	for (const type of ["agent_idle", "extension_ui_request", "agent_event", "event_lease", "session_parked"])
		host.writer.enqueue(sessionId, { type });
	await host.writer.flush();
	expect(
		peer.inbox.slice(from).filter((frame) => frame.sessionId === sessionId && frame.admissionId !== undefined),
	).toEqual([]);
	expect(host.writer.routesAdmission(host.writer.socketEpochOf("peer") ?? "", "d")).toBe(false);
}, 600_000);
