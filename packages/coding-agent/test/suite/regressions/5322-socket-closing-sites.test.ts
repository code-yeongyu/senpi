import { afterEach, expect, it, vi } from "vitest";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { dataOf, type RawClient, statusHost, type WireRecord } from "../rpc-session-status-support.ts";

// RULING-124 (#5322): every engine-initiated close of a compact peer is preceded by one `socket_closing` record, the
// last record the peer receives. One case per close site, driven at router level with the flag on; the queue-failure
// site is in 5322-socket-closing-transport.test.ts.

const FLAG = "SENPI_ENGINE_SOCKET_COMPACT_UPDATES";
const PAIR = ["compact_message_updates_v1", "event_resync"];

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

type Host = Awaited<ReturnType<typeof statusHost>>;

/** A peer whose socket the engine may close: resolves with the number of lines it had received at the close. */
function closablePeer(host: Host, name = "peer") {
	const closed = Promise.withResolvers<number>();
	const peer: RawClient = host.client(name, { close: () => closed.resolve(peer.received.length) });
	return { peer, closed: closed.promise };
}

/** Sends a command the engine may answer only after the close: nothing waits for its reply. */
const send = (host: Host, name: string, command: Record<string, unknown>) =>
	host.writer.withConnection(name, () => host.core.handle(JSON.stringify({ ...command, id: `${name}-raw` })));

const parsed = (line: string | undefined): WireRecord => JSON.parse(line ?? "null");

async function expectAnnounced(peer: RawClient, closed: Promise<number>, code: string, detail?: string) {
	const at = await closed;
	expect(at, "the close came after every line the peer received").toBe(peer.received.length);
	expect(parsed(peer.received.at(-1))).toEqual({
		type: "socket_closing",
		code,
		retryable: code !== "compact_endpoint_unsupported",
		...(detail === undefined ? {} : { detail }),
	});
}

/** A session whose checkpoint freezes fail from now on: its generation space is exhausted. */
function exhaust(host: Host, sessionId: string) {
	const lane = host.writer.recoveryLane(sessionId) ?? expect.unreachable("the session owns a lane with the flag on");
	vi.spyOn(lane.generations, "next").mockReturnValue(undefined);
	return lane;
}

async function compactHost() {
	vi.stubEnv(FLAG, "1");
	return statusHost();
}

it("RULING-124 (d) compact-required-streams: a required mirror whose checkpoint cannot be frozen announces the close", async () => {
	await using host = await compactHost();
	const owner = host.client("owner");
	const sessionId = String(dataOf(await owner.request({ type: "open_session", cwd: host.cwd })).sessionId);
	const { peer, closed } = closablePeer(host);
	await peer.request({ type: "set_client_info", width: 100, capabilities: PAIR });
	exhaust(host, sessionId);
	void send(host, "peer", { type: "subscribe_sessions", admissionId: "m", mirror: "all" }).catch(() => {});
	await expectAnnounced(peer, closed, "checkpoint_unavailable", "unavailable");
}, 600_000);

it("RULING-124 (d) compact-required-streams: a dirty stream whose re-freeze fails announces the close", async () => {
	await using host = await compactHost();
	const owner = host.client("owner");
	const sessionId = String(dataOf(await owner.request({ type: "open_session", cwd: host.cwd })).sessionId);
	const { peer, closed } = closablePeer(host);
	await peer.request({ type: "subscribe_sessions", admissionId: "m", mirror: ["agent_start"] });
	const lane = host.writer.recoveryLane(sessionId) ?? expect.unreachable();
	// A record the mirror does not select leaves the stream dirty; the next selected one re-freezes it.
	lane.accept({ type: "turn_start" }, undefined);
	exhaust(host, sessionId);
	lane.accept({ type: "agent_start" }, undefined);
	await expectAnnounced(peer, closed, "checkpoint_unavailable", "unavailable");
}, 600_000);

it("RULING-124 (d) session-event-writer-recovery: a mirrored record whose checkpoint cannot be frozen announces the close", async () => {
	await using host = await compactHost();
	const { peer, closed } = closablePeer(host);
	await peer.request({ type: "subscribe_sessions", admissionId: "m", mirror: "all" });
	const owner = host.client("owner");
	const sessionId = String(dataOf(await owner.request({ type: "open_session", cwd: host.cwd })).sessionId);
	const socketEpoch = host.writer.socketEpochOf("peer") ?? expect.unreachable();
	// The routed record finds no frozen route for the mirror, so routing freezes one itself.
	host.writer.recoveryCheckpoints.retireRoute({ socketEpoch, sessionId }, "m", "mirror_unsubscribed");
	exhaust(host, sessionId);
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	host.writer.enqueue(sessionId, { type: "agent_start" });
	await expectAnnounced(peer, closed, "checkpoint_unavailable", "unavailable");
}, 600_000);

it("RULING-124 compact-materializer-line: past the lease bound the refusal, then socket_closing, then the close", async () => {
	await using host = await compactHost();
	const { peer, closed } = closablePeer(host);
	const sessionId = String((await peer.request({ type: "open_session", cwd: host.cwd, admissionId: "a" })).sessionId);
	const limit = host.writer.recoveryEvents?.peerLimit ?? expect.unreachable("event leases exist with the flag on");
	for (let index = 0; index <= limit; index++) host.writer.enqueue(sessionId, { type: "agent_start" });
	await expectAnnounced(peer, closed, "event_lease_refused", "lease_limit");
	expect(parsed(peer.received.at(-2))).toMatchObject({ type: "event_lease_refused", reason: "lease_limit" });
}, 600_000);

it("RULING-124 session-event-writer-destinations: past the ordinary lease bound the refusal, then socket_closing, then the close", async () => {
	await using host = await compactHost();
	const owner = host.client("owner");
	const sessionId = String(dataOf(await owner.request({ type: "open_session", cwd: host.cwd })).sessionId);
	const { peer, closed } = closablePeer(host);
	host.writer.setConnectionCapabilities("peer", ["compact_events"]);
	host.writer.attachConnectionToSession("peer", sessionId);
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	const limit = host.writer.recoveryEvents?.peerLimit ?? expect.unreachable("event leases exist with the flag on");
	for (let index = 0; index <= limit; index++)
		host.writer.enqueue(sessionId, {
			type: "tool_execution_end",
			toolCallId: `call-${index}`,
			toolName: "read",
			result: { content: [{ type: "text", text: String(index % 10).repeat(263_000) }] },
			isError: false,
		});
	await expectAnnounced(peer, closed, "event_lease_refused", "lease_limit");
	expect(parsed(peer.received.at(-2))).toMatchObject({ type: "event_lease_refused", reason: "lease_limit" });
}, 600_000);

it("RULING-124 session-event-writer-destinations: a compact mirror of a lane-less session is refused, announced, then closed", async () => {
	vi.stubEnv(FLAG, "1");
	const writer = new SessionEventWriter(() => {});
	const received: string[] = [];
	const closed = Promise.withResolvers<number>();
	writer.registerConnection("peer", {
		writeRaw: (line) => void received.push(line),
		waitForBackpressure: async () => {},
		close: () => closed.resolve(received.length),
	});
	expect(writer.compactSelection("peer")?.declare(PAIR, true, () => true)).toBeUndefined();
	writer.setConnectionCapabilities("peer", PAIR);
	writer.attachConnectionToSession("peer", "worker-session");
	// The mirror registry is the one seam: a worker session whose isolate owns no acceptance lane is mirrored to it.
	vi.spyOn(writer.status, "mirrorTargets").mockReturnValue(["peer"]);
	writer.enqueue("worker-session", { type: "agent_start" });
	expect(await closed.promise).toBe(received.length);
	expect(received.slice(-2).map(parsed)).toEqual([
		{ type: "compact_refused", sessionId: "worker-session", reason: "compact_endpoint_unsupported" },
		{ type: "socket_closing", code: "compact_endpoint_unsupported", retryable: false },
	]);
});
