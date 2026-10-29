import { afterEach, expect, it, vi } from "vitest";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

it("T2 mirror admissions route initial and later matches behind their identity and manifest without holds", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const owner = host.client("owner");
	const peer = host.client("peer");
	const first = await owner.request({ type: "open_session", cwd: host.cwd });
	const subscribed = await peer.request({ type: "subscribe_sessions", admissionId: "mirror", mirror: "all" });
	const baseline = await peer.waitFor((frame) => frame.type === "recovery_manifest");
	expect(peer.inbox.indexOf(subscribed)).toBeLessThan(peer.inbox.indexOf(baseline));
	const later = await owner.request({ type: "open_session", cwd: host.cwd });
	for (const opened of [first, later]) {
		const sessionId = String(dataOf(opened).sessionId);
		host.writer.enqueue(sessionId, { type: "agent_start" });
		await host.writer.flush();
		const suffix = peer.inbox.find((frame) => frame.type === "agent_start" && frame.sessionId === sessionId);
		expect(suffix).toMatchObject({ admissionId: "mirror", generation: expect.any(Number) });
		expect(peer.inbox.indexOf(baseline)).toBeLessThan(peer.inbox.indexOf(suffix ?? {}));
		const token = host.writer.recoveryCheckpoints.tokens().find((value) => value.admission.sessionId === sessionId);
		expect(token?.admission).toMatchObject({ admissionId: "mirror", routeKind: "mirror", peer: "peer" });
	}
	expect(dataOf(await owner.request({ type: "list_sessions" })).sessions).toEqual([
		expect.objectContaining({ attachments: 1 }),
		expect.objectContaining({ attachments: 1 }),
	]);
}, 120_000);

it.each(["get_recovery_page", "release_recovery"])(
	"T2 mirror content %s uses the inherited flag and server-peer ownership gate",
	async (type) => {
		vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
		vi.stubEnv("SENPI_RPC_REQUIRE_ATTACH", "1");
		await using host = await statusHost();
		const owner = host.client("owner");
		const peer = host.client("peer");
		const foreign = host.client("foreign");
		const opened = await owner.request({ type: "open_session", cwd: host.cwd });
		const sessionId = String(dataOf(opened).sessionId);
		await peer.request({ type: "subscribe_sessions", admissionId: "mirror", mirror: "all" });
		const manifest = await peer.waitFor((frame) => frame.type === "recovery_manifest");
		host.writer.enqueue(sessionId, { type: "agent_start" });
		await host.writer.flush();
		expect(host.writer.isCompactSubscription("peer", "mirror", sessionId)).toBe(true);
		const command = {
			id: "denied",
			type,
			sessionId,
			admissionId: "mirror",
			lease: manifest.eventLease,
			componentRef: "record",
			requestId: "page",
			peer: "peer",
			connectionId: "peer",
			socketEpoch: host.writer.socketEpochOf("peer"),
		};
		const page = vi.spyOn(host.writer.recoveryPages ?? expect.unreachable(), "request");
		const release = vi.spyOn(host.writer.recoveryEvents ?? expect.unreachable(), "release");
		const denied: string[] = [];
		for (const route of [
			{},
			{ sessionId: "unknown" },
			{ sessionId: "../malformed", admissionId: "bad/id" },
			{ admissionId: undefined },
		]) {
			const from = foreign.received.length;
			await host.writer.withConnection("foreign", () => host.core.handle(JSON.stringify({ ...command, ...route })));
			await host.writer.flush();
			denied.push(foreign.received.slice(from).join(""));
		}
		expect(denied[0]).toContain('"errorCode":"unknown_admission"');
		expect(denied[1]).toBe(denied[0]);
		expect(denied[2]).toContain('"reason":"malformed_request"');
		expect(denied[3]).toContain('"errorCode":"session_not_attached"');
		expect(page).not.toHaveBeenCalled();
		expect(release).not.toHaveBeenCalled();
		expect(await peer.request({ ...command, peer: "foreign", connectionId: "foreign" })).not.toMatchObject({
			errorCode: "session_not_attached",
		});
		expect(type === "get_recovery_page" ? page : release).toHaveBeenCalledOnce();
		vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "0");
		expect(await peer.request(command)).toMatchObject({ errorCode: "session_not_attached" });
	},
	120_000,
);

it("T2/Y07 peer end removes the old actor subscription, prevents stale routing and cannot authorize pages", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	vi.stubEnv("SENPI_RPC_REQUIRE_ATTACH", "1");
	await using host = await statusHost();
	const owner = host.client("owner");
	const opened = await owner.request({ type: "open_session", cwd: host.cwd });
	const peer = host.client("peer");
	const response = await peer.request({ type: "subscribe_sessions", admissionId: "old", mirror: "all" });
	const subscriptionId = String(dataOf(response).subscriptionId);
	const manifest = await peer.waitFor((frame) => frame.type === "recovery_manifest");
	await host.drop("peer");
	expect(host.writer.isCompactSubscription("peer", "old", subscriptionId)).toBe(false);
	const replacement = host.client("peer");
	const refused = await replacement.request({
		type: "get_recovery_page",
		sessionId: subscriptionId,
		admissionId: "old",
		lease: manifest.eventLease,
		componentRef: "record",
		requestId: "stale",
	});
	expect(refused).toMatchObject({ success: false, errorCode: "unknown_admission" });
	expect(refused).not.toHaveProperty("generation");
	host.writer.enqueue(String(dataOf(opened).sessionId), { type: "agent_start" });
	await host.writer.flush();
	expect(
		replacement.inbox.some(
			(frame) =>
				frame.type !== "response" && (frame.admissionId === "old" || frame.subscriptionId === subscriptionId),
		),
	).toBe(false);
}, 120_000);
