#!/usr/bin/env node
import { mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname } from "node:path";

const socketPath = process.argv[2];
const serverVersion = process.argv[3] ?? "fixture-version";
const capabilities = (process.argv[4] ?? "multi_session,extension_events").split(",").filter(Boolean);
const behavior = process.argv[5] ?? "answer";
if (!socketPath) throw new Error("socket path required");
await mkdir(dirname(socketPath), { recursive: true });
await rm(socketPath, { force: true });
if (behavior === "ignore-term") process.on("SIGTERM", () => {});
const server = createServer((socket) => {
	let buffer = "";
	socket.on("data", (chunk) => {
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
server.listen(socketPath);
process.on("SIGTERM", () => {
	if (behavior === "ignore-term") return;
	server.close(() => process.exit(0));
});
