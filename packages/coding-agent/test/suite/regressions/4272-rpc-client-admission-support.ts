import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import { attachJsonlLineReader } from "../../../src/modes/rpc/jsonl.ts";
import { RpcClient } from "../../../src/modes/rpc/rpc-client.ts";
import { socketSink } from "../../../src/modes/rpc/socket-sink.ts";
import { statusHost } from "../rpc-session-status-support.ts";

export async function admissionClient() {
	const host = await statusHost();
	const requests: Record<string, unknown>[] = [];
	const frames: string[] = [];
	const handlers: Promise<void>[] = [];
	const failures: unknown[] = [];
	const socketPath = join(dirname(host.cwd), "admission.sock");
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
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	const client = new RpcClient({ socketPath });
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
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await host[Symbol.asyncDispose]();
		},
	};
}
