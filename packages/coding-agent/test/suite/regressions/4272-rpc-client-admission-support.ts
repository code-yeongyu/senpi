import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { attachJsonlLineReader } from "../../../src/modes/rpc/jsonl.ts";
import { RpcClient } from "../../../src/modes/rpc/rpc-client.ts";
import { socketSink } from "../../../src/modes/rpc/socket-sink.ts";
import { statusHost } from "../rpc-session-status-support.ts";

/** The longest unix socket path every supported platform accepts (macOS sun_path is 104 bytes, Linux 108, both NUL-terminated). */
const SOCKET_PATH_MAX = 103;

/**
 * Listen `server` on a unix socket in its own short directory under tmpdir(). A path too long for sun_path fails here by
 * name, and any listen error rejects instead of leaving the test to hang until its budget.
 */
export async function listenOnShortSocket(server: Server, name: string) {
	const dir = await mkdtemp(join(tmpdir(), "s"));
	const socketPath = join(dir, name);
	try {
		const bytes = Buffer.byteLength(socketPath);
		if (bytes > SOCKET_PATH_MAX)
			throw new Error(
				`socket path too long: ${bytes} bytes > ${SOCKET_PATH_MAX} (${socketPath}); set a shorter TMPDIR`,
			);
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, () => {
				server.off("error", reject);
				resolve();
			});
		});
	} catch (cause) {
		await rm(dir, { recursive: true, force: true });
		throw cause;
	}
	return {
		socketPath,
		async close() {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(dir, { recursive: true, force: true });
		},
	};
}

export async function admissionClient() {
	const host = await statusHost();
	const requests: Record<string, unknown>[] = [];
	const frames: string[] = [];
	const handlers: Promise<void>[] = [];
	const failures: unknown[] = [];
	const server = createServer((socket) => {
		const sink = socketSink(socket);
		host.writer.registerConnection("rpc-client", {
			...sink,
			writeRaw: (line) => {
				frames.push(line);
				sink.writeRaw(line);
			},
		});
		attachJsonlLineReader(socket, (line) => {
			requests.push(JSON.parse(line));
			const handled = host.writer.withConnection("rpc-client", () => host.core.handle(line));
			handlers.push(handled);
			void handled.catch((cause: unknown) => failures.push(cause));
		});
	});
	const listener = await listenOnShortSocket(server, "admission.sock").catch(async (cause: unknown) => {
		await host[Symbol.asyncDispose]();
		throw cause;
	});
	const client = new RpcClient({ socketPath: listener.socketPath });
	await client.start();
	// #4272 C8.2 / RULING-73: compact admission starts only after support and the pair ACK.
	if (process.env.SENPI_ENGINE_SOCKET_COMPACT_UPDATES === "1") {
		const pair = ["compact_message_updates_v1", "event_resync"];
		expect(
			await host.writer.withConnection("rpc-client", () => host.core.router.handle({ type: "get_protocol_info" })),
		).toMatchObject({ data: { capabilities: expect.arrayContaining(pair) } });
		await client.setClientInfo(100, pair);
		expect(frames.map((line) => JSON.parse(line))).toContainEqual(
			expect.objectContaining({
				command: "set_client_info",
				success: true,
				data: { capabilities: pair },
			}),
		);
	}
	return {
		host,
		client,
		requests,
		frames,
		failures,
		async [Symbol.asyncDispose]() {
			await client.stop();
			host.writer.unregisterConnection("rpc-client");
			await host.core.router.releaseConnection("rpc-client");
			await Promise.all(handlers);
			await listener.close();
			await host[Symbol.asyncDispose]();
		},
	};
}
