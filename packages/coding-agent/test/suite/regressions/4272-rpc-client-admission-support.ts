import { createServer } from "node:net";
import { dirname, join } from "node:path";
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
