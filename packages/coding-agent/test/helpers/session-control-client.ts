import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { socketSecretPath } from "../../src/modes/rpc/socket-transport.ts";

export type ControlReply =
	| { readonly kind: "answered"; readonly record: Readonly<Record<string, unknown>> }
	| { readonly kind: "closed"; readonly bytes: number };

export function controlRequest(
	socket: string,
	command: Readonly<Record<string, unknown>>,
	secret: Uint8Array = readFileSync(socketSecretPath(socket)),
): Promise<ControlReply> {
	const id = typeof command.id === "string" ? command.id : `req-${Math.random().toString(36).slice(2)}`;
	return new Promise((resolve) => {
		const connection = createConnection(socket);
		let buffer = "";
		let bytes = 0;
		connection.once("connect", () => {
			connection.write(Buffer.from(secret));
			connection.write(`${JSON.stringify({ ...command, id })}\n`);
		});
		connection.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			buffer += chunk.toString("utf8");
			for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
				const record: Record<string, unknown> = JSON.parse(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				if (record.id === id) {
					connection.destroy();
					resolve({ kind: "answered", record });
					return;
				}
			}
		});
		connection.once("close", () => resolve({ kind: "closed", bytes }));
		connection.once("error", () => resolve({ kind: "closed", bytes }));
	});
}

export async function controlData(socket: string, command: Readonly<Record<string, unknown>>): Promise<unknown> {
	const reply = await controlRequest(socket, command);
	if (reply.kind !== "answered") throw new Error(`control socket closed on ${String(command.type)}`);
	return reply.record.success === true ? reply.record.data : reply.record;
}
