/**
 * The private channel between the server and one tool child generation (senpi#3566, plan todo 4).
 *
 * The server listens on a per-generation socket inside a 0700 directory, guarded by a 0600 secret the child must send
 * first (`socket-transport.ts`), and accepts exactly one connection; the listener closes after it. The child learns the
 * address and the secret file from its environment, never from argv. Frames are `codec.ts` length-prefixed frames, never
 * stdout, so nothing a tool prints can corrupt the protocol. Any codec error is terminal for the channel.
 */
import { chmod, rm, rmdir } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import {
	authenticateSocket,
	readSocketSecret,
	resolveSocketTransportAddress,
	sendSocketHandshake,
} from "../socket-transport.ts";
import { encodeFrame, FrameDecoder, ToolChildCodecError } from "./codec.ts";
import type { ToolChildMessage } from "./protocol.ts";
import { claimListenerFiles } from "./socket-root.ts";

export const TOOL_CHILD_ROLE_ENV = "SENPI_INTERNAL_ROLE";
export const TOOL_CHILD_CHANNEL_ENV = "SENPI_TOOL_CHILD_CHANNEL";
export const TOOL_CHILD_SECRET_ENV = "SENPI_TOOL_CHILD_CHANNEL_SECRET";

export type ChannelCloseReason =
	| { readonly kind: "eof" }
	| { readonly kind: "codec"; readonly code: ToolChildCodecError["code"] }
	| { readonly kind: "error"; readonly message: string };

export interface ToolChildChannel {
	send(message: ToolChildMessage): boolean;
	/** Subscribes; the returned function unsubscribes. */
	onMessage(listener: (message: ToolChildMessage) => void): () => void;
	readonly closed: Promise<ChannelCloseReason>;
	close(): void;
}

export function wrapChannelSocket(socket: Socket): ToolChildChannel {
	const decoder = new FrameDecoder();
	const listeners: Array<(message: ToolChildMessage) => void> = [];
	// Frames that arrive before anyone listens (a child's `hello` races the server's subscription) wait here.
	const early: ToolChildMessage[] = [];
	let settle!: (reason: ChannelCloseReason) => void;
	const closed = new Promise<ChannelCloseReason>((resolve) => {
		settle = resolve;
	});
	let reason: ChannelCloseReason | undefined;
	const finish = (next: ChannelCloseReason): void => {
		if (reason !== undefined) return;
		reason = next;
		socket.destroy();
		settle(next);
	};
	socket.on("data", (chunk: Buffer) => {
		if (reason !== undefined) return;
		try {
			for (const message of decoder.push(chunk)) {
				if (listeners.length === 0) early.push(message);
				else for (const listener of listeners) listener(message);
			}
		} catch (error) {
			finish(
				error instanceof ToolChildCodecError
					? { kind: "codec", code: error.code }
					: { kind: "error", message: String(error) },
			);
		}
	});
	socket.on("end", () => {
		try {
			decoder.end();
			finish({ kind: "eof" });
		} catch (error) {
			finish(
				error instanceof ToolChildCodecError
					? { kind: "codec", code: error.code }
					: { kind: "error", message: String(error) },
			);
		}
	});
	socket.on("error", (error) => finish({ kind: "error", message: error.message }));
	socket.on("close", () => finish({ kind: "eof" }));
	return {
		send: (message) => reason === undefined && socket.write(encodeFrame(message)),
		onMessage: (listener) => {
			listeners.push(listener);
			for (const message of early.splice(0)) listener(message);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		closed,
		close: () => finish({ kind: "eof" }),
	};
}

export interface ChannelListener {
	readonly env: Readonly<Record<typeof TOOL_CHILD_CHANNEL_ENV | typeof TOOL_CHILD_SECRET_ENV, string>>;
	/** The first authenticated connection; the listener stops accepting once it arrives. */
	readonly accepted: Promise<ToolChildChannel>;
	close(): Promise<void>;
}

export async function openChannelListener(options: {
	readonly dir: string;
	readonly generation: number;
}): Promise<ChannelListener> {
	const { logicalPath, secretPath, secret } = await claimListenerFiles(options.dir, options.generation);
	let resolveAccepted!: (channel: ToolChildChannel) => void;
	const accepted = new Promise<ToolChildChannel>((resolve) => {
		resolveAccepted = resolve;
	});
	let taken = false;
	const server = createServer((socket) => {
		if (taken) {
			socket.destroy();
			return;
		}
		authenticateSocket(socket, secret, () => {
			if (taken) {
				socket.destroy();
				return;
			}
			taken = true;
			server.close();
			resolveAccepted(wrapChannelSocket(socket));
		});
	});
	const address = resolveSocketTransportAddress(logicalPath, process.platform, secret);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(address, () => {
			server.off("error", reject);
			resolve();
		});
	});
	if (process.platform !== "win32") await chmod(logicalPath, 0o600);
	return {
		env: { [TOOL_CHILD_CHANNEL_ENV]: logicalPath, [TOOL_CHILD_SECRET_ENV]: secretPath },
		accepted,
		close: async () => {
			taken = true;
			// Stops accepting only: `server.close(callback)` would wait for the accepted channel itself to end.
			if (server.listening) server.close();
			// The socket goes before the secret: while our secret is in it the root is non-empty, so no sibling sweep can
			// remove it and no other user can put anything at its name that this removal would reach (senpi#3694).
			if (process.platform !== "win32") await rm(logicalPath, { force: true });
			await rm(secretPath, { force: true });
			// The socket root is shared by every generation of this session's tool-child dir (and, on the fallback,
			// by every process starting one), so rmdir removes it only once it is empty. A sibling that claimed the
			// root but has not written its secret yet can lose it here; `claimListenerFiles` re-claims and retries.
			await rmdir(dirname(logicalPath)).catch(() => {});
		},
	};
}

export function channelEnvPresent(env: NodeJS.ProcessEnv): boolean {
	return Boolean(env[TOOL_CHILD_CHANNEL_ENV]) && Boolean(env[TOOL_CHILD_SECRET_ENV]);
}

export async function connectChannel(env: NodeJS.ProcessEnv): Promise<ToolChildChannel> {
	const logicalPath = env[TOOL_CHILD_CHANNEL_ENV];
	const secretPath = env[TOOL_CHILD_SECRET_ENV];
	if (!logicalPath || !secretPath) throw new Error("tool-child: channel unavailable");
	const secret = await readSocketSecret(secretPath);
	const socket = createConnection(resolveSocketTransportAddress(logicalPath, process.platform, secret));
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	sendSocketHandshake(socket, secret);
	return wrapChannelSocket(socket);
}
