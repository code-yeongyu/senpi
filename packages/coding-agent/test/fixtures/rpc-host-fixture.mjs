#!/usr/bin/env node
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, win32 } from "node:path";

const socketPath = process.argv[2];
const serverVersion = process.argv[3] ?? "fixture-version";
const capabilities = (process.argv[4] ?? "multi_session,extension_events").split(",").filter(Boolean);
const behavior = process.argv[5] ?? "answer";
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
				data: { protocolVersion: 1, serverVersion, capabilities, mode: "multi" },
			})}\n`);
		}
	});
});
server.listen(transportAddress);
process.on("SIGTERM", () => {
	if (behavior === "ignore-term") return;
	server.close(() => process.exit(0));
});
