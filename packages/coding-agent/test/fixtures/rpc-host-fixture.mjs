#!/usr/bin/env node
/**
 * A protocol-answering stand-in for the RPC socket host, used by the ensure/handoff suites.
 *
 * It is spawned DETACHED (by `ensureHost` itself in most cases), so nothing holds a handle to it
 * and a case that leaves an unusable registration behind - an unguarded pidfile, a failed ensure -
 * has no way to stop it. Two self-terminating bindings keep that from stranding a host: the fixture
 * exits when the socket path it serves disappears (which happens the moment its sandbox directory
 * is removed), and when its parent is gone (a killed test runner reparents it to init).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, win32 } from "node:path";

const socketPath = process.argv[2];
const serverVersion = process.argv[3] ?? "fixture-version";
const capabilities = (process.argv[4] ?? "multi_session,extension_events").split(",").filter(Boolean);
const behavior = process.argv[5] ?? "answer";
/** Optional JSON merged into the protocol answer: instanceId, generation, engineOrdinal, launch_profile. */
const identity = process.argv[6] ? JSON.parse(process.argv[6]) : {};
if (!socketPath) throw new Error("socket path required");
await mkdir(dirname(socketPath), { recursive: true });
if (process.platform !== "win32") await rm(socketPath, { force: true });
let secret;
if (process.platform === "win32") {
	const secretPath = `${socketPath}.secret`;
	try {
		secret = await readFile(secretPath);
	} catch {
		secret = randomBytes(32);
		await writeFile(secretPath, secret, { mode: 0o600 });
	}
}
const transportAddress =
	process.platform === "win32"
		? `\\\\.\\pipe\\senpi-rpc-${createHash("sha256").update(Buffer.concat([Buffer.from(win32.normalize(socketPath).toLowerCase(), "utf8"), secret ?? Buffer.alloc(0)])).digest("hex").slice(0, 32)}`
		: socketPath;
if (behavior === "ignore-term") process.on("SIGTERM", () => {});
const server = createServer((socket) => {
	let buffer = "";
	let handshake = Buffer.alloc(0);
	let authenticated = process.platform !== "win32";
	socket.on("data", (chunk) => {
		if (!authenticated) {
			handshake = Buffer.concat([handshake, chunk]);
			if (handshake.length < secret.length) return;
			if (!timingSafeEqual(handshake.subarray(0, secret.length), secret)) return socket.destroy();
			authenticated = true;
			chunk = handshake.subarray(secret.length);
		}
		buffer += chunk.toString("utf8");
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (behavior === "silent") continue;
			const request = JSON.parse(line);
			socket.write(`${JSON.stringify({
				id: request.id,
				type: "response",
				command: "get_protocol_info",
				success: true,
				data: { protocolVersion: 1, serverVersion, capabilities, mode: "multi", ...identity },
			})}\n`);
		}
	});
});
server.listen(transportAddress);
process.on("SIGTERM", () => {
	if (behavior === "ignore-term") return;
	server.close(() => process.exit(0));
});

/** How often the fixture checks that it still has a reason to exist. */
const SELF_TERMINATION_INTERVAL_MS = 500;
const parentPid = process.ppid;
const watchdog = setInterval(() => {
	// The socket entry is this fixture's whole purpose; on win32 the pipe has no filesystem entry,
	// so the sandbox directory that holds its secret is the equivalent evidence.
	const servingPath = process.platform === "win32" ? dirname(socketPath) : socketPath;
	const orphaned = process.ppid !== parentPid && process.ppid <= 1;
	if (existsSync(servingPath) && !orphaned) return;
	clearInterval(watchdog);
	server.close(() => process.exit(0));
	// A connected client can hold `close` open; the fixture is disposable, so do not wait for it.
	setTimeout(() => process.exit(0), 1_000).unref();
}, SELF_TERMINATION_INTERVAL_MS);
// Never the reason the fixture stays alive.
watchdog.unref();
