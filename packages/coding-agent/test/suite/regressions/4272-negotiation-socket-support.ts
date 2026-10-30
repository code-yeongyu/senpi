import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import { attachJsonlLineReader } from "../../../src/modes/rpc/jsonl.ts";
import type { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import type { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { socketSink } from "../../../src/modes/rpc/socket-sink.ts";
import { within, type WireRecord } from "./4272-worker-acceptance-support.ts";

/** Production router/writer over real TCP sockets; readiness and records are event-controlled. */
export async function negotiationSockets(writer: SessionEventWriter, router: SessionCommandRouter) {
	const sockets = new Set<Socket>();
	const handlers = new Set<Promise<void>>();
	const failures: unknown[] = [];
	let serial = 0;
	const server = createServer((socket) => {
		sockets.add(socket);
		const peer = "socket-" + ++serial;
		writer.registerConnection(peer, socketSink(socket));
		attachJsonlLineReader(socket, (line) => {
			const job = writer.withConnection(peer, async () => {
				const response = await router.handle(JSON.parse(line));
				if (response) await writer.enqueueControl(response);
			});
			handlers.add(job);
			void job.catch((error) => failures.push(error)).finally(() => handlers.delete(job));
		});
		socket.once("close", () => {
			writer.unregisterConnection(peer);
			sockets.delete(socket);
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return {
		failures,
		async connect() {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("missing TCP listener");
			const socket = createConnection(address.port, "127.0.0.1");
			await once(socket, "connect");
			const records: WireRecord[] = [];
			const listeners = new Set<(record: WireRecord) => void>();
			attachJsonlLineReader(socket, (line) => {
				const record: WireRecord = JSON.parse(line);
				records.push(record);
				for (const listener of listeners) listener(record);
			});
			let requestId = 0;
			const next = (predicate: (record: WireRecord) => boolean, name: string) => {
				const result = Promise.withResolvers<WireRecord>();
				const listener = (record: WireRecord) => {
					if (!predicate(record)) return;
					listeners.delete(listener);
					result.resolve(record);
				};
				listeners.add(listener);
				return within(name, result.promise).catch((cause) => {
					throw new Error(
						String(cause) +
							"; server failures=" +
							failures.map(String).join(",") +
							"; records=" +
							JSON.stringify(
								records.map((r) => ({ type: r.type, command: r.command, id: r.id, sessionId: r.sessionId })),
							),
					);
				});
			};
			return {
				records,
				socket,
				waitFor(predicate: (record: WireRecord) => boolean) {
					return next(predicate, "socket event");
				},
				send(command: WireRecord) {
					socket.write(JSON.stringify(command) + "\n");
				},
				async request(command: WireRecord) {
					const id = command.id ?? "req-" + ++requestId;
					const reply = next(
						(record) => record.type === "response" && record.id === id,
						"negotiation " + command.type,
					);
					socket.write(JSON.stringify({ ...command, id }) + "\n");
					return reply;
				},
				async close() {
					const closed = once(socket, "close");
					socket.destroy();
					await closed;
				},
			};
		},
		async [Symbol.asyncDispose]() {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await Promise.allSettled([...handlers]);
		},
	};
}
