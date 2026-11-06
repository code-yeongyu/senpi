// senpi#5840 (win32-sim): on Windows the hand's named pipe is guarded the way the shared RPC host guards its own: an
// owner-only `<hand.sock>.secret` file, and a connection becomes the carrier only after it sent those bytes first. The
// gate itself (`authenticateSocket`) is platform-independent, so it is driven here over a real Unix socket.
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handEndpointSecret, handSocketPath } from "../../../src/modes/hand/hand-entry.ts";
import { type CarrierSide, serveSocketCarrier } from "../../../src/modes/hand/socket-carrier.ts";
import { SOCKET_SECRET_BYTES, sendSocketHandshake, socketSecretPath } from "../../../src/modes/rpc/socket-transport.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function scratchDir(): string {
	const dir = mkdtempSync(join("/tmp", "s5840w-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

interface Recorded {
	readonly side: CarrierSide;
	readonly attached: Array<Parameters<CarrierSide["attached"]>[0]>;
	readonly messages: unknown[];
}

function recordingSide(): Recorded {
	const attached: Recorded["attached"] = [];
	const messages: unknown[] = [];
	return {
		attached,
		messages,
		side: {
			attached: (connection) => attached.push(connection),
			message: (message) => messages.push(message),
			writable: () => {},
			detached: () => {},
		},
	};
}

async function gatedServer(secret: Uint8Array, side: CarrierSide): Promise<string> {
	const path = join(scratchDir(), "hand.sock");
	const server: Server = createServer();
	serveSocketCarrier(server, side, secret);
	await new Promise<void>((resolve) => server.listen(path, resolve));
	cleanups.push(() => server.close());
	return path;
}

async function dial(path: string): Promise<Socket> {
	const socket = createConnection(path);
	cleanups.push(() => socket.destroy());
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	return socket;
}

const closed = (socket: Socket): Promise<void> =>
	new Promise((resolve) => (socket.destroyed ? resolve() : socket.once("close", () => resolve())));

const ackLine = `${JSON.stringify({ kind: "ack", lane: "scope-1", seq: 1 })}\n`;

describe("hand endpoint secret (win32-sim)", () => {
	it("creates an owner-only secret file on Windows only, and keeps it across starts", async () => {
		const socketPath = handSocketPath(scratchDir(), "linux");
		expect(await handEndpointSecret(socketPath, "linux")).toBeUndefined();

		const secret = await handEndpointSecret(socketPath, "win32");
		expect(secret?.length).toBe(SOCKET_SECRET_BYTES);
		expect(statSync(socketSecretPath(socketPath)).mode & 0o777).toBe(0o600);
		expect(await handEndpointSecret(socketPath, "win32")).toEqual(secret);
	});
});

describe("secret-gated carrier (win32-sim)", () => {
	const secret = new Uint8Array(SOCKET_SECRET_BYTES).fill(7);

	it("refuses a connection that sends the wrong secret", async () => {
		const recorded = recordingSide();
		const socket = await dial(await gatedServer(secret, recorded.side));
		sendSocketHandshake(socket, new Uint8Array(SOCKET_SECRET_BYTES).fill(9));
		socket.write(ackLine);
		await closed(socket);
		expect(recorded.attached).toEqual([]);
		expect(recorded.messages).toEqual([]);
	});

	it("refuses a connection that sends no secret", async () => {
		const recorded = recordingSide();
		const socket = await dial(await gatedServer(secret, recorded.side));
		socket.write(ackLine.repeat(2));
		await closed(socket);
		expect(recorded.attached).toEqual([]);
		expect(recorded.messages).toEqual([]);
	});

	it("attaches a connection that sends the secret first", async () => {
		const recorded = recordingSide();
		const socket = await dial(await gatedServer(secret, recorded.side));
		const delivered = new Promise<void>((resolve) => {
			const message = recorded.side.message;
			Object.assign(recorded.side, {
				message: (value: unknown) => {
					message(value);
					resolve();
				},
			});
		});
		sendSocketHandshake(socket, secret);
		socket.write(ackLine);
		await delivered;
		expect(recorded.attached).toHaveLength(1);
		expect(recorded.messages).toEqual([{ kind: "ack", lane: "scope-1", seq: 1 }]);
	});

	it("keeps the authenticated carrier when a connection without the secret arrives", async () => {
		const recorded = recordingSide();
		const path = await gatedServer(secret, recorded.side);
		const carrier = await dial(path);
		const attachedOnce = new Promise<void>((resolve) => {
			const attached = recorded.side.attached;
			Object.assign(recorded.side, {
				attached: (connection: Parameters<CarrierSide["attached"]>[0]) => {
					attached(connection);
					resolve();
				},
			});
		});
		sendSocketHandshake(carrier, secret);
		await attachedOnce;

		const intruder = await dial(path);
		intruder.write(ackLine.repeat(2));
		await closed(intruder);

		const received = new Promise<string>((resolve) =>
			carrier.once("data", (chunk: Buffer) => resolve(String(chunk))),
		);
		expect(recorded.attached[0]?.send({ kind: "ack", lane: "scope-1", seq: 3 })).toBe(true);
		expect(JSON.parse((await received).trim())).toEqual({ kind: "ack", lane: "scope-1", seq: 3 });
		expect(recorded.attached).toHaveLength(1);
		expect(carrier.destroyed).toBe(false);
	});
});
