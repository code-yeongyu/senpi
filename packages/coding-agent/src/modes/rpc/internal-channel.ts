import { randomBytes } from "node:crypto";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { createInternalRecordStream } from "./internal-record-stream.ts";
import { MAX_RPC_LINE_CHARACTERS } from "./jsonl.ts";
import { RPC_AUTH_HEX, rpcAuthProof, rpcProofMatches } from "./rpc-auth-proof.ts";

type Frame = Record<string, unknown>;
const INTERNAL_LAUNCH_ID = "internal";

/** One HMAC and constant-time comparison for both endpoints (wire contract v1.1); the hop's launch id is "internal". */
function proof(key: Buffer, label: "server" | "client", first: string, second: string): string {
	return rpcAuthProof(key, label, INTERNAL_LAUNCH_ID, first, second);
}
function matches(actual: unknown, expected: string): boolean {
	return rpcProofMatches(expected, actual);
}
function object(value: unknown): Frame {
	if (!isObject(value)) throw new Error("auth_failed");
	return value;
}
function isObject(value: unknown): value is Frame {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonce(value: unknown): string {
	if (typeof value !== "string" || !RPC_AUTH_HEX.test(value)) throw new Error("auth_failed");
	return value;
}

/**
 * The host (server) side guards its pre-auth reads with the 8 KiB / 2 s budget (design 2b/2e), fragmented frames and
 * bytes coalesced after authentication included. The supervisor-side client bounds a line by the normal RPC ceiling;
 * its deadline is the caller's: the readiness probe and the activity observer pass one (a child that accepts and never
 * answers must fail, senpi#3816 review), while the proxy forwarding a public connection passes none, so a host whose
 * event loop stalls still serves the connections made meanwhile, as raw connections were.
 */
const HOST_PRE_AUTH_BUDGET = { maxBytes: 8192, timeoutMs: 2000 } as const;

async function handshake<T>(
	socket: Socket,
	budget: { readonly maxBytes: number; readonly timeoutMs: number | undefined },
	run: (read: () => Promise<Frame>, send: (frame: Frame) => Promise<void>) => Promise<T>,
): Promise<T> {
	let readBytes = 0;
	let ended = false;
	let rejectPending: ((cause: Error) => void) | undefined;
	const fail = (error: Error) => {
		ended = true;
		rejectPending?.(error);
		socket.destroy();
	};
	const timer =
		budget.timeoutMs === undefined
			? undefined
			: setTimeout(() => fail(new Error("internal_auth_timeout")), budget.timeoutMs);
	timer?.unref();
	const onError = (error: Error) => fail(error);
	const onClose = () => fail(new Error("internal_hop_lost"));
	socket.on("error", onError);
	socket.once("close", onClose);
	const read = (): Promise<Frame> =>
		new Promise((resolve, reject) => {
			if (ended) return reject(new Error("internal_hop_lost"));
			let buffer = Buffer.alloc(0);
			rejectPending = (cause) => {
				socket.off("data", data);
				reject(cause);
			};
			const data = (chunk: Buffer) => {
				const newline = chunk.indexOf(10);
				const used = newline === -1 ? chunk.length : newline + 1;
				readBytes += used;
				if (readBytes > budget.maxBytes) return fail(new Error("internal_auth_oversized"));
				buffer = Buffer.concat([buffer, chunk.subarray(0, used)]);
				if (newline === -1) return;
				socket.pause();
				socket.off("data", data);
				rejectPending = undefined;
				if (used < chunk.length) socket.unshift(chunk.subarray(used));
				try {
					resolve(object(JSON.parse(buffer.toString("utf8"))));
				} catch {
					reject(new Error("auth_failed"));
				}
			};
			socket.on("data", data);
			socket.resume();
		});
	try {
		return await run(
			read,
			(frame) =>
				new Promise<void>((resolve, reject) => {
					socket.write(`${JSON.stringify(frame)}\n`, (error) => (error ? reject(error) : resolve()));
				}),
		);
	} catch (cause) {
		socket.destroy();
		throw cause;
	} finally {
		if (timer) clearTimeout(timer);
		socket.off("error", onError);
		socket.off("close", onClose);
	}
}

/** `timeoutMs` bounds the whole client handshake on a monotonic timer; omitted, there is no deadline. */
export function connectInternalConnection(
	socket: Socket,
	key: Buffer,
	options: { readonly timeoutMs?: number } = {},
): Promise<Duplex> {
	return handshake(socket, { maxBytes: MAX_RPC_LINE_CHARACTERS, timeoutMs: options.timeoutMs }, async (read, send) => {
		const clientNonce = randomBytes(32).toString("hex");
		const [response] = await Promise.all([
			read(),
			send({
				id: "internal-protocol",
				type: "get_protocol_info",
				observe: true,
				auth: { client_nonce: clientNonce },
			}),
		]);
		// A reply without a server proof is a host that cannot prove the key (or speaks another protocol).
		const data = response.data;
		if (!isObject(data) || !isObject(data.auth)) throw new Error("host_identity_unproven");
		const auth = data.auth;
		const serverNonce = nonce(auth.server_nonce);
		if (
			response.id !== "internal-protocol" ||
			response.success !== true ||
			auth.launch_id !== INTERNAL_LAUNCH_ID ||
			!matches(auth.server_proof, proof(key, "server", clientNonce, serverNonce))
		)
			throw new Error("host_identity_unproven");
		const [result] = await Promise.all([
			read(),
			send({
				id: "internal-auth",
				type: "authenticate",
				client_proof: proof(key, "client", serverNonce, clientNonce),
			}),
		]);
		if (result.id !== "internal-auth" || result.command !== "authenticate" || result.success !== true)
			throw new Error("auth_failed");
		return createInternalRecordStream(
			socket,
			key,
			Buffer.from(clientNonce, "hex"),
			Buffer.from(serverNonce, "hex"),
			"client",
		);
	});
}

export function acceptInternalConnection(socket: Socket, key: Buffer, protocol: Frame = {}): Promise<Duplex> {
	return handshake(socket, HOST_PRE_AUTH_BUDGET, async (read, send) => {
		// Wire contract frame 5: any other first frame, a first frame without a valid nonce, or a command before
		// authenticate is answered auth_required naming that command, then the connection closes.
		const refuse = async (frame: Frame): Promise<never> => {
			await send({
				id: frame.id,
				type: "response",
				command: frame.type,
				success: false,
				error: "auth_required",
				errorCode: "auth_required",
			});
			throw new Error("auth_required");
		};
		const first = await read();
		const offered = isObject(first.auth) ? first.auth.client_nonce : undefined;
		if (first.type !== "get_protocol_info" || typeof offered !== "string" || !RPC_AUTH_HEX.test(offered))
			return refuse(first);
		const clientNonce = offered;
		const serverNonce = randomBytes(32).toString("hex");
		const [frame] = await Promise.all([
			read(),
			send({
				id: first.id,
				type: "response",
				command: first.type,
				success: true,
				data: {
					...protocol,
					capabilities: [...(Array.isArray(protocol.capabilities) ? protocol.capabilities : []), "socket_auth"],
					auth: {
						launch_id: INTERNAL_LAUNCH_ID,
						server_nonce: serverNonce,
						server_proof: proof(key, "server", clientNonce, serverNonce),
					},
				},
			}),
		]);
		if (frame.type !== "authenticate") return refuse(frame);
		const valid = matches(frame.client_proof, proof(key, "client", serverNonce, clientNonce));
		await send({
			id: frame.id,
			type: "response",
			command: "authenticate",
			success: valid,
			...(valid ? {} : { error: "auth_failed", errorCode: "auth_failed" }),
		});
		if (!valid) throw new Error("auth_failed");
		return createInternalRecordStream(
			socket,
			key,
			Buffer.from(clientNonce, "hex"),
			Buffer.from(serverNonce, "hex"),
			"server",
		);
	});
}
