import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { expect, it } from "vitest";
import { attachJsonlLineReader } from "../../src/modes/rpc/jsonl.ts";
import { RpcClient } from "../../src/modes/rpc/rpc-client.ts";
import { proof, sandbox, teardown, type Wire } from "./rpc-public-auth-harness.ts";

// #3795: refresh is one authenticated retry, never a keyless downgrade.
it.skipIf(process.platform === "win32")(
	"reconnects and re-reads a replacement launch exactly once on auth_failed",
	async () => {
		const qa = await sandbox();
		const keys = join(qa.agentDir, "rpc", "keys");
		await mkdir(keys, { recursive: true, mode: 0o700 });
		const launches = [0, 1].map(() => ({ id: randomUUID(), key: randomBytes(32) }));
		for (const launch of launches) {
			await writeFile(
				join(keys, launch.id),
				JSON.stringify({
					version: 1,
					launch_id: launch.id,
					key: launch.key.toString("hex"),
					pid: process.pid,
					process_start: null,
					endpoint: qa.socket,
					created_at: new Date().toISOString(),
				}),
				{ mode: 0o600 },
			);
		}
		let connections = 0;
		const commands: string[] = [];
		const sockets = new Set<Socket>();
		const server = createServer((socket) => {
			sockets.add(socket);
			socket.once("close", () => sockets.delete(socket));
			socket.on("error", () => {});
			const index = connections++;
			const launch = launches[index];
			if (!launch) {
				socket.destroy();
				return;
			}
			const nonce = randomBytes(32).toString("hex");
			let clientNonce = "";
			attachJsonlLineReader(socket, (line) => {
				const request: Wire = JSON.parse(line);
				commands.push(String(request.type));
				const base = { id: request.id, type: "response", command: request.type, success: true };
				if (request.type === "get_protocol_info") {
					clientNonce = (request.auth as { client_nonce: string }).client_nonce;
					socket.write(
						`${JSON.stringify({
							...base,
							data: {
								capabilities: ["socket_auth"],
								auth: {
									launch_id: launch.id,
									server_nonce: nonce,
									server_proof: proof(launch.key, "senpi-rpc-server", launch.id, clientNonce, nonce),
								},
							},
						})}\n`,
					);
				} else if (request.type === "authenticate") {
					expect(request.client_proof).toBe(proof(launch.key, "senpi-rpc-client", launch.id, nonce, clientNonce));
					if (index === 0)
						socket.end(
							`${JSON.stringify({ ...base, success: false, error: "auth_failed", errorCode: "auth_failed" })}\n`,
						);
					else socket.write(`${JSON.stringify(base)}\n`);
				} else socket.write(`${JSON.stringify({ ...base, data: { sessions: [] } })}\n`);
			});
		});
		await new Promise<void>((resolve) => server.listen(qa.socket, resolve));
		const options = { socketPath: qa.socket, keyRoot: qa.agentDir };
		const client = new RpcClient(options);
		try {
			await client.start();
			expect(await client.listSessions()).toEqual([]);
			expect(connections).toBe(2);
			expect(commands).toEqual([
				"get_protocol_info",
				"authenticate",
				"get_protocol_info",
				"authenticate",
				"list_sessions",
			]);
		} finally {
			await client.stop();
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await teardown(qa.root);
		}
	},
);
