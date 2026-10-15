/**
 * The terminal's control listener. Every connection must present the 32-byte secret first
 * (`authenticateSocket`, the handshake every RPC transport shares); a wrong secret is disconnected
 * before a single JSONL line is read. After that it is the RPC framing: one LF-terminated JSON
 * object per request, one response per request carrying its `id`, plus pushed feed events.
 */
import { chmod } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { attachJsonlLineReader, MAX_RPC_LINE_CHARACTERS, serializeJsonLine } from "../rpc/jsonl.ts";
import { rpcCommandShapeError } from "../rpc/rpc-input-validation.ts";
import type { SessionEventWriterConnection } from "../rpc/session-event-fanout.ts";
import { socketSink } from "../rpc/socket-sink.ts";
import { authenticateSocket } from "../rpc/socket-transport.ts";

export interface ControlConnection {
	readonly id: number;
	send(record: object): void;
	/** The raw socket writer, for an endpoint that orders this connection's output through a record writer. */
	readonly transport: SessionEventWriterConnection;
}

export type ControlCommand = Readonly<Record<string, unknown>> & { readonly type: string; readonly id?: unknown };

export interface ControlServerHandlers {
	/** `null`: the command already answered on its own (through the endpoint's record writer). */
	command(connection: ControlConnection, command: ControlCommand): Promise<object | null>;
	/** An authenticated connection is about to send its first line. */
	opened?(connection: ControlConnection): void;
	/** Writes a command's answer; without it the answer goes straight to the socket. */
	respond?(connection: ControlConnection, answer: object): void;
	closed(connection: ControlConnection): void;
	listenerError(error: Error): void;
}

export interface ControlServer {
	close(): Promise<void>;
}

export async function listenControlSocket(
	socketPath: string,
	secret: Uint8Array,
	handlers: ControlServerHandlers,
): Promise<ControlServer> {
	const clients = new Set<Socket>();
	let nextConnection = 0;
	const server = createServer((socket) => {
		clients.add(socket);
		socket.once("close", () => clients.delete(socket));
		socket.on("error", () => socket.destroy());
		authenticateSocket(socket, secret, () => acceptConnection(socket, ++nextConnection, handlers));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});
	server.on("error", (error) => handlers.listenerError(error));
	await chmod(socketPath, 0o600);
	return { close: () => closeServer(server, clients) };
}

function acceptConnection(socket: Socket, id: number, handlers: ControlServerHandlers): void {
	const connection: ControlConnection = {
		id,
		// Every record, answers and feed events alike, leaves through the endpoint's writer when it has one,
		// so this connection's output keeps one order.
		send: (record) => {
			if (handlers.respond !== undefined) handlers.respond(connection, record);
			else if (!socket.destroyed) socket.write(serializeJsonLine(record));
		},
		transport: socketSink(socket),
	};
	handlers.opened?.(connection);
	const detach = attachJsonlLineReader(socket, (line) => void answer(connection, line, handlers), {
		maxLineLength: MAX_RPC_LINE_CHARACTERS,
		onOversizedLine: () => connection.send(failure(undefined, "parse", "RPC line exceeds the size limit.")),
	});
	socket.once("close", () => {
		detach();
		handlers.closed(connection);
	});
}

async function answer(connection: ControlConnection, line: string, handlers: ControlServerHandlers): Promise<void> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		connection.send(failure(undefined, "parse", "Invalid JSON."));
		return;
	}
	const shapeError = rpcCommandShapeError(parsed);
	if (shapeError !== undefined || !isCommand(parsed)) {
		connection.send(failure(undefined, "parse", shapeError ?? "RPC command needs a string `type`."));
		return;
	}
	const answer = await handlers.command(connection, parsed);
	if (answer === null) return;
	connection.send(answer);
}

function isCommand(value: unknown): value is ControlCommand {
	return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

export function failure(id: unknown, command: string, error: string): object {
	return { ...(id === undefined ? {} : { id }), type: "response", command, success: false, error };
}

export function success(id: unknown, command: string, data?: unknown): object {
	return {
		...(id === undefined ? {} : { id }),
		type: "response",
		command,
		success: true,
		...(data === undefined ? {} : { data }),
	};
}

function closeServer(server: Server, clients: Set<Socket>): Promise<void> {
	for (const client of clients) client.destroy();
	return new Promise((resolve) => server.close(() => resolve()));
}
