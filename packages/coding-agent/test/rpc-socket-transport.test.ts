import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
	authenticateSocket,
	createSocketSecret,
	readSocketSecret,
	resolveSocketTransportAddress,
	sendSocketHandshake,
	socketSecretPath,
} from "../src/modes/rpc/socket-transport.ts";

describe("Windows RPC socket security", () => {
	it("writes and reads a 32-byte secret with owner-only mode", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-rpc-secret-"));
		try {
			const path = socketSecretPath(join(root, "rpc.sock"));
			const secret = await createSocketSecret(path);
			expect(secret).toHaveLength(32);
			expect(await readSocketSecret(path)).toEqual(secret);
			if (process.platform !== "win32") {
				// win32 does not enforce POSIX mode bits (stat reports 0o666); the
				// Windows boundary is the authenticated handshake + profile-dir ACL.
				expect((await stat(path)).mode & 0o777).toBe(0o600);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("derives different pipe names for the same logical path with different secrets", () => {
		const path = "C:\\\\Users\\\\demo\\\\rpc.sock";
		expect(resolveSocketTransportAddress(path, "win32", randomBytes(32))).not.toBe(
			resolveSocketTransportAddress(path, "win32", randomBytes(32)),
		);
	});

	it("rejects a client before registration when the handshake is wrong", async () => {
		const server = createServer((socket) =>
			authenticateSocket(socket, Buffer.alloc(32, 7), () => socket.write("registered")),
		);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (typeof address !== "object" || address === null) throw new Error("missing test address");
		const socket = createConnection(address.port, "127.0.0.1");
		await new Promise<void>((resolve) => socket.once("connect", resolve));
		sendSocketHandshake(socket, Buffer.alloc(32, 8));
		await new Promise<void>((resolve) => socket.once("close", resolve));
		expect(socket.destroyed).toBe(true);
		server.close();
	});

	// Platform contract: on win32 the secret handshake is the only boundary of a named pipe, so a wrong
	// secret must end the connection before the listener reads, or answers, a single JSONL frame.
	it.skipIf(process.platform !== "win32")(
		"refuses a wrong secret on a real named pipe before answering any JSONL byte",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "senpi-rpc-pipe-"));
			const secret = randomBytes(32);
			const address = resolveSocketTransportAddress(join(root, "rpc.sock"), "win32", secret);
			const authenticated: Socket[] = [];
			const server = createServer((connection) =>
				authenticateSocket(connection, secret, () => {
					authenticated.push(connection);
					connection.on("data", () =>
						connection.write(`${JSON.stringify({ type: "response", success: true })}\n`),
					);
				}),
			);
			try {
				server.listen(address);
				await once(server, "listening");
				expect(address).toMatch(/^\\\\\.\\pipe\\senpi-rpc-/);

				const refused = await pipeExchange(address, randomBytes(32));
				expect(refused).toEqual({ kind: "closed", bytes: 0 });
				expect(authenticated).toHaveLength(0);

				// The same pipe answers the same frame once the secret is right, so the refusal above is the
				// handshake's verdict and not a pipe that never served anything.
				const answered = await pipeExchange(address, secret);
				expect(answered).toEqual({ kind: "answered", record: { type: "response", success: true } });
				expect(authenticated).toHaveLength(1);
			} finally {
				for (const connection of authenticated) connection.destroy();
				server.close();
				await rm(root, { recursive: true, force: true });
			}
		},
	);
});

/** Connects, sends the handshake and one JSONL frame, and reports the first answered line or the close. */
async function pipeExchange(
	address: string,
	secret: Uint8Array,
): Promise<
	{ readonly kind: "answered"; readonly record: unknown } | { readonly kind: "closed"; readonly bytes: number }
> {
	const socket = createConnection(address);
	// A refused client may see EPIPE/ECONNRESET on its own write; the close and its byte count are the verdict.
	socket.on("error", () => {});
	await once(socket, "connect");
	let received = Buffer.alloc(0);
	const outcome = new Promise<
		{ readonly kind: "answered"; readonly record: unknown } | { readonly kind: "closed"; readonly bytes: number }
	>((resolve) => {
		socket.on("data", (chunk: Buffer) => {
			received = Buffer.concat([received, chunk]);
			const newline = received.indexOf(0x0a);
			if (newline === -1) return;
			resolve({ kind: "answered", record: JSON.parse(received.subarray(0, newline).toString("utf8")) });
			socket.destroy();
		});
		socket.once("close", () => resolve({ kind: "closed", bytes: received.length }));
	});
	sendSocketHandshake(socket, secret);
	socket.write(`${JSON.stringify({ id: "probe", type: "get_protocol_info" })}\n`);
	return outcome;
}

describe("resolveSocketTransportAddress", () => {
	it("maps a logical Windows socket path to one deterministic named pipe", () => {
		// Given
		const logicalSocket = "C:\\Users\\demo\\.omo\\rpc\\rpc.sock";
		const expectedHash = createHash("sha256")
			.update(win32.normalize(logicalSocket).toLowerCase(), "utf8")
			.digest("hex")
			.slice(0, 32);

		// When
		const address = resolveSocketTransportAddress(logicalSocket, "win32");

		// Then
		expect(address).toBe(`\\\\.\\pipe\\senpi-rpc-${expectedHash}`);
	});

	it("canonicalizes Windows path aliases to the same pipe", () => {
		expect(resolveSocketTransportAddress("C:/Users/demo/rpc.sock", "win32")).toBe(
			resolveSocketTransportAddress("c:\\users\\demo\\rpc.sock", "win32"),
		);
	});

	it("rejects relative and root-relative Windows logical paths", () => {
		expect(() => resolveSocketTransportAddress("rpc.sock", "win32")).toThrow("drive-qualified or UNC");
		expect(() => resolveSocketTransportAddress("\\foo", "win32")).toThrow("drive-qualified or UNC");
		expect(() => resolveSocketTransportAddress("/foo", "win32")).toThrow("drive-qualified or UNC");
	});

	it("accepts drive-qualified and UNC Windows logical paths", () => {
		expect(resolveSocketTransportAddress("C:\\foo", "win32")).toMatch(/^\\\\\.\\pipe\\senpi-rpc-/);
		expect(resolveSocketTransportAddress("\\\\server\\share\\foo", "win32")).toMatch(/^\\\\\.\\pipe\\senpi-rpc-/);
	});

	it("preserves explicit named-pipe addresses", () => {
		expect(resolveSocketTransportAddress("\\\\.\\pipe\\existing", "win32")).toBe("\\\\.\\pipe\\existing");
	});

	it("maps the same logical socket to the same pipe for every caller", () => {
		// Given
		const logicalSocket = "C:\\Users\\demo\\.omo\\rpc\\rpc.sock";

		// When
		const listenerAddress = resolveSocketTransportAddress(logicalSocket, "win32");
		const clientAddress = resolveSocketTransportAddress(logicalSocket, "win32");

		// Then
		expect(clientAddress).toBe(listenerAddress);
	});

	it("preserves POSIX filesystem and abstract socket addresses", () => {
		// Given
		const filesystemSocket = "/tmp/senpi/rpc.sock";
		const abstractSocket = "\0senpi-rpc";

		// When
		const resolvedFilesystem = resolveSocketTransportAddress(filesystemSocket, "linux");
		const resolvedAbstract = resolveSocketTransportAddress(abstractSocket, "linux");

		// Then
		expect(resolvedFilesystem).toBe(filesystemSocket);
		expect(resolvedAbstract).toBe(abstractSocket);
	});
});
