import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/config.ts";
import { ProcessIdentityUnreadableError, processMatchesPidFile } from "../src/modes/app-server/daemon/process.ts";
import { createHostDaemonPaths, ensureHost } from "../src/modes/rpc/host-ensure.ts";
import { settledOpportunisticHostGc } from "../src/modes/rpc/host-gc-pass.ts";
import {
	authenticateSocket,
	createSocketSecret,
	resolveSocketTransportAddress,
	socketSecretPath,
} from "../src/modes/rpc/socket-transport.ts";

describe("RPC ownership observation", () => {
	it("does not classify an absent identity on a live pid as gone", async () => {
		await expect(
			processMatchesPidFile(
				{ pid: process.pid, processStartTime: "identity" },
				async () => undefined,
				() => true,
				{ attempts: 1 },
			),
		).rejects.toBeInstanceOf(ProcessIdentityUnreadableError);
	});

	it("still recognizes confirmed absence and a different process identity", async () => {
		const recorded = { pid: process.pid, processStartTime: "identity" };
		expect(
			await processMatchesPidFile(
				recorded,
				async () => undefined,
				() => false,
				{ attempts: 1 },
			),
		).toBe(false);
		expect(
			await processMatchesPidFile(
				recorded,
				async () => "replacement",
				() => true,
				{ attempts: 1 },
			),
		).toBe(false);
	});

	it("concurrent callers reuse a compatible endpoint without consulting an unavailable ownership probe", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-identity-"));
		const agentDirs = [join(root, "one"), join(root, "two")];
		const socketPath = join(root, "rpc.sock");
		const secret = process.platform === "win32" ? await createSocketSecret(socketSecretPath(socketPath)) : undefined;
		const connections = new Set<Socket>();
		let replies = 0;
		let probes = 0;
		const server = createServer((socket) => {
			connections.add(socket);
			socket.once("close", () => connections.delete(socket));
			const serve = () => {
				let buffer = "";
				socket.on("data", (chunk) => {
					buffer += chunk.toString();
					if (!buffer.includes("\n")) return;
					const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
					replies += 1;
					socket.end(
						`${JSON.stringify({ id: request.id, success: true, data: { protocolVersion: 1, serverVersion: VERSION, capabilities: ["multi_session", "extension_events", "session_context", "session_kind"] } })}\n`,
					);
				});
			};
			if (secret) authenticateSocket(socket, secret, serve);
			else serve();
		});
		try {
			const listening = once(server, "listening", { signal: AbortSignal.timeout(5_000) });
			server.listen(resolveSocketTransportAddress(socketPath, process.platform, secret));
			await listening;
			for (const agentDir of agentDirs) {
				const paths = createHostDaemonPaths({ socket: socketPath, agentDir });
				await mkdir(join(paths.generationsDir, "regression"), { recursive: true });
				await writeFile(
					join(paths.generationsDir, "regression", "host.pid"),
					JSON.stringify({ pid: process.pid, processStartTime: "unavailable", socket: socketPath }),
				);
				await writeFile(
					paths.pointerFile,
					JSON.stringify({ layout: 2, instance_id: "regression", generation_dir: "generations/regression" }),
				);
				await writeFile(paths.settingsFile, "preserved");
			}
			const results = await Promise.allSettled(
				agentDirs.map((agentDir) =>
					ensureHost({
						agentDir,
						socket: socketPath,
						_test: {
							readProcessStartTime: async () => {
								probes += 1;
								throw new Error("identity query unavailable");
							},
						},
					}),
				),
			);
			expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
			for (const result of results) if (result.status === "fulfilled") expect(result.value.reused).toBe(true);
			expect(replies).toBe(2);
			expect(probes).toBe(0);
			for (const agentDir of agentDirs)
				expect(await readFile(createHostDaemonPaths({ socket: socketPath, agentDir }).settingsFile, "utf8")).toBe(
					"preserved",
				);
		} finally {
			for (const socket of connections) socket.destroy();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			// senpi#2779: ensureHost returns before its GC completion marker is written.
			await Promise.all(agentDirs.map(settledOpportunisticHostGc));
			await rm(root, { recursive: true, force: true });
		}
	});
});
