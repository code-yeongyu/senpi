import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachJsonlLineReader, serializeJsonLine } from "../../src/modes/rpc/jsonl.ts";
import {
	authenticateSocket,
	createSocketSecret,
	resolveSocketTransportAddress,
} from "../../src/modes/rpc/socket-transport.ts";

export interface EndpointOptions {
	/** Commands left unanswered, as a stalled endpoint would. */
	readonly hold?: readonly string[];
	/** Commands refused with the given error. */
	readonly refuse?: Readonly<Record<string, string>>;
	/** The listed row's `retain_on_disconnect`; true unless a case needs a non-retained session. */
	readonly retained?: boolean;
	/** The reply to an `extension_ui_response`: success by default, a refusal's error, or none at all. */
	readonly answer?: (command: Record<string, unknown>) => { readonly error: string } | "none" | undefined;
}

export async function endpoint(options: EndpointOptions = {}) {
	const directory = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "attach-"));
	const path = join(directory, "t-0123456789abcdef.sock");
	const secret = await createSocketSecret(`${path}.secret`);
	const commands: Array<Record<string, unknown>> = [];
	let peer: Socket | undefined;
	const server = createServer((socket) => {
		peer = socket;
		authenticateSocket(socket, secret, () => {
			attachJsonlLineReader(socket, (line) => {
				const command: Record<string, unknown> = JSON.parse(line);
				commands.push(command);
				let data: unknown;
				switch (command.type) {
					case "list_sessions":
						data = {
							sessions: [
								{
									sessionId: "live",
									durableSessionId: "durable",
									cwd: "/fixture",
									status: "open",
									retain_on_disconnect: options.retained ?? true,
								},
							],
						};
						break;
					case "attach_session":
						data = { sessionId: "live", attached: true };
						break;
					case "get_state":
						data = { sessionId: "durable", cwd: "/fixture", isStreaming: false, pendingDialogs: [] };
						break;
					case "get_entries":
						data = {
							entries: [
								{
									type: "message",
									id: "history",
									parentId: null,
									timestamp: "2026-01-01",
									message: { role: "user", content: "Previous question", timestamp: 1 },
								},
							],
							leafId: "history",
							next_before: command.before ? undefined : "history",
						};
						break;
					case "subscribe_sessions":
						data = {
							subscriptionId: "sub",
							snapshot: [],
							seq: 0,
							hostGeneration: "fixture",
							hostInstanceId: "fixture",
						};
						break;
					case "release_attachment":
						data = { deferred: false };
						break;
					case "extension_ui_response": {
						const answer = options.answer?.(command);
						if (answer !== "none")
							socket.write(
								serializeJsonLine({
									type: "response",
									id: command.id,
									command: command.type,
									...(answer ? { success: false, error: answer.error } : { success: true }),
								}),
							);
						server.emit("command", command);
						return;
					}
					default:
						data = {};
				}
				const refusal = options.refuse?.[String(command.type)];
				if (!options.hold?.includes(String(command.type)))
					socket.write(
						serializeJsonLine(
							refusal === undefined
								? { type: "response", id: command.id, command: command.type, success: true, data }
								: { type: "response", id: command.id, command: command.type, success: false, error: refusal },
						),
					);
				server.emit("command", command);
			});
		});
	});
	const listening = once(server, "listening");
	server.listen(resolveSocketTransportAddress(path, process.platform, secret));
	await listening;
	const close = async () => {
		peer?.destroy();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		await rm(directory, { recursive: true, force: true });
	};
	return {
		close,
		path,
		commands,
		send: (record: object) => peer?.write(serializeJsonLine({ sessionId: "live", ...record })),
		/** Writes one raw line, as a misbehaving endpoint would. */
		sendRaw: (line: string) => peer?.write(`${line}\n`),
		disconnect: () => peer?.destroy(),
		command(type: string) {
			return this.waitFor((record) => record.type === type);
		},
		/** The first command, already received or still to come, that satisfies `predicate`. */
		async waitFor(predicate: (record: Record<string, unknown>) => boolean) {
			const signal = AbortSignal.timeout(5000);
			for (;;) {
				const found = commands.find(predicate);
				if (found) return found;
				await once(server, "command", { signal });
			}
		},
	};
}
