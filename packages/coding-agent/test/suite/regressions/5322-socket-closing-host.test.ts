import { once } from "node:events";
import { createConnection } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { endpoint, type WorkerHostRecord } from "../rpc-host-endpoint.ts";
import { startInProcessHost } from "../rpc-worker-host-support.ts";

// RULING-124 (#5322): a host shutdown and a generation handoff are engine-initiated socket closes too. A compact peer
// receives its session records first, then `socket_closing` naming why the socket goes away, then the close.

const PAIR = ["compact_message_updates_v1", "event_resync"];

afterEach(() => vi.unstubAllEnvs());

async function compactClient() {
	// Force the source CLI: the default helper boots `dist/cli.js`, which would not carry this change until a rebuild.
	vi.stubEnv("SENPI_RPC_TEST_BUN", process.execPath);
	const host = await startInProcessHost(undefined, { SENPI_ENGINE_SOCKET_COMPACT_UPDATES: "1" });
	const socket = createConnection(host.socketPath);
	socket.on("error", () => {});
	await once(socket, "connect", { signal: AbortSignal.timeout(10_000) });
	const wire = endpoint(socket, socket, host.stderrText);
	const closed = once(socket, "close").then(() => [...wire.records]);
	expect(await wire.request({ type: "set_client_info", width: 100, capabilities: PAIR })).toMatchObject({
		success: true,
	});
	const dispose = async () => {
		wire.dispose();
		socket.destroy();
		await host.dispose();
	};
	return { host, wire, closed, dispose };
}

/** A compact client holding one retained session, so a drain parks it and then closes the socket. */
async function retainedClient() {
	const client = await compactClient();
	const opened = await client.wire.request({
		type: "open_session",
		cwd: client.host.cwd,
		admissionId: "a",
		retain_on_disconnect: true,
	});
	expect(opened).toMatchObject({ success: true });
	return { ...client, sessionId: opened.sessionId };
}

const closing = (code: string) => ({ type: "socket_closing", code, retryable: true });

it("RULING-124 (d) host shutdown: session_closed, then socket_closing host_shutdown, then the close", async () => {
	const client = await compactClient();
	try {
		const opened = await client.wire.request({ type: "open_session", cwd: client.host.cwd, admissionId: "a" });
		expect(opened).toMatchObject({ success: true });
		client.host.child.kill("SIGTERM");
		const records: WorkerHostRecord[] = await client.closed;
		expect(records.at(-1)).toEqual(closing("host_shutdown"));
		expect(records.slice(0, -1)).toContainEqual(
			expect.objectContaining({ type: "session_closed", sessionId: opened.sessionId, reason: "host_shutdown" }),
		);
	} finally {
		await client.dispose();
	}
}, 120_000);

it.skipIf(process.platform === "win32")(
	"RULING-124 (d) generation handoff: the parked session's record, then socket_closing host_handoff, then the close",
	async () => {
		const client = await retainedClient();
		try {
			client.host.child.kill("SIGUSR1");
			const records: WorkerHostRecord[] = await client.closed;
			expect(records.at(-1)).toEqual(closing("host_handoff"));
			expect(records.slice(0, -1)).toContainEqual(
				expect.objectContaining({ sessionId: client.sessionId, reason: "handoff_parked" }),
			);
		} finally {
			await client.dispose();
		}
	},
	120_000,
);
