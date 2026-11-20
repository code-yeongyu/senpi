import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOST_EXIT_REFUSED } from "../../../src/modes/rpc/host-outcome.ts";
import { mapError } from "../../../src/modes/rpc/host-session-errors.ts";
import { attachJsonlLineReader } from "../../../src/modes/rpc/jsonl.ts";
import { connectAuthenticatedRpcSocket } from "../../../src/modes/rpc/rpc-auth-client.ts";
import { RpcEndpointAuthError } from "../../../src/modes/rpc/rpc-auth-proof.ts";
import { challenge, Peer } from "../rpc-public-auth-harness.ts";
import {
	authenticatedClient,
	openSpare,
	type SteppedSupervisor,
	stepUntil,
	steppedSupervisor,
	type Wire,
} from "./7055-stepped-engine-support.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.unstubAllEnvs();
});

async function supervisor(): Promise<SteppedSupervisor> {
	const s = await steppedSupervisor();
	cleanups.push(() => s.dispose());
	return s;
}

async function peer(s: SteppedSupervisor): Promise<Peer> {
	const connected = await Peer.connect(s.publicPath);
	cleanups.push(() => {
		connected.socket.destroy();
	});
	return connected;
}

/** A first client to arm the refill, then the spare opened as engine connection 2. */
async function withSpare(s: SteppedSupervisor): Promise<void> {
	const first = await authenticatedClient(s);
	cleanups.push(() => {
		first.socket.destroy();
	});
	await openSpare(s, 2);
}

const recordsOn = (s: SteppedSupervisor, conn: number) =>
	s.engine.history.flatMap((turn) => (turn.kind === "record" && turn.conn === conn ? [turn.type] : []));

describe.skipIf(process.platform === "win32")("senpi#7055 bounded public authentication", () => {
	it("refuses a challenge the engine has not answered within the supervisor's budget, typed and at once", async () => {
		const s = await supervisor();
		const client = await peer(s);
		const reply = client.request({
			type: "get_protocol_info",
			id: "protocol",
			observe: true,
			auth: { client_nonce: "ab".repeat(32) },
		});
		await s.timers.whenArmed(1500);
		s.timers.fire(1500);
		expect(await reply).toEqual({
			id: "protocol",
			type: "response",
			command: "get_protocol_info",
			success: false,
			error: "host_overloaded",
			errorCode: "host_overloaded",
			errorData: { retry_after_ms: 1500 },
		});
		await client.closed;
		expect(await s.engine.step()).toEqual({ kind: "accept", conn: 1 });
		await s.engine.whenClosed(1);
		expect(recordsOn(s, 1)).toEqual([]);
	});

	it("refuses a wrong proof on a spare hop exactly as before and discards that hop", async () => {
		const s = await supervisor();
		await withSpare(s);
		const client = await peer(s);
		await stepUntil(s.engine, challenge(client));
		const refused = await client.request({ type: "authenticate", id: "authenticate", client_proof: "00".repeat(32) });
		expect(refused).toMatchObject({ success: false, errorCode: "auth_failed" });
		await s.engine.whenClosed(2);
		expect(recordsOn(s, 2)).toEqual(["get_protocol_info", "get_protocol_info"]);
	});

	it("refuses a command sent before authenticate under enforcement; it never reaches the engine", async () => {
		vi.stubEnv("SENPI_RPC_REQUIRE_TOKEN", "1");
		const s = await supervisor();
		await withSpare(s);
		const client = await peer(s);
		await stepUntil(s.engine, challenge(client));
		const refused = await client.request({ type: "list_sessions", id: "early" });
		expect(refused).toMatchObject({ success: false, errorCode: "auth_required" });
		await s.engine.whenClosed(2);
		expect(recordsOn(s, 2)).toEqual(["get_protocol_info", "get_protocol_info"]);
	});
});

describe.skipIf(process.platform === "win32")("senpi#7055 client side of host_overloaded", () => {
	async function overloadingHost(retryAfterMs: number) {
		const root = await mkdtemp(join(tmpdir(), "o7055-"));
		const path = join(root, "h.sock");
		let connections = 0;
		const sockets: Socket[] = [];
		const server = createServer((socket) => {
			const connection = ++connections;
			sockets.push(socket);
			attachJsonlLineReader(socket, (line) => {
				const request: Wire = JSON.parse(line);
				const answer =
					connection === 1
						? {
								success: false,
								error: "host_overloaded",
								errorCode: "host_overloaded",
								errorData: { retry_after_ms: retryAfterMs },
							}
						: { success: true, data: { protocolVersion: 1 } };
				socket.write(`${JSON.stringify({ id: request.id, type: "response", command: request.type, ...answer })}\n`);
			});
		});
		server.listen(path);
		await once(server, "listening");
		cleanups.push(async () => {
			for (const socket of sockets) socket.destroy();
			server.close();
			await rm(root, { recursive: true, force: true });
		});
		return { path, root, connections: () => connections };
	}

	it("throws a typed retryable error carrying retryAfterMs when the retry does not fit the caller's budget", async () => {
		const host = await overloadingHost(60_000);
		const failure = await connectAuthenticatedRpcSocket(host.path, undefined, { keyRoot: host.root }, 10_000).catch(
			(cause: unknown) => cause,
		);
		expect(failure).toBeInstanceOf(RpcEndpointAuthError);
		expect(failure).toMatchObject({ code: "host_overloaded", retryAfterMs: 60_000 });
		expect(host.connections()).toBe(1);
		expect(mapError(failure, "s")).toEqual({
			exitCode: HOST_EXIT_REFUSED,
			payload: {
				action: "refuse",
				reason: "host_overloaded",
				detail: (failure as Error).message,
				socket: "s",
				data: { retry_after_ms: 60_000 },
			},
		});
	});

	it("reconnects after retry_after_ms when it fits the caller's budget", async () => {
		const host = await overloadingHost(0);
		const { socket } = await connectAuthenticatedRpcSocket(host.path, undefined, { keyRoot: host.root }, 10_000);
		socket.destroy();
		expect(host.connections()).toBe(2);
	});
});
