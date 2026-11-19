/**
 * The supervisor's readiness probes of its private hop: whether the host child listens and answers as the key holder.
 * Moved out of `host-lifecycle-proxy.ts` for its size (senpi#7055).
 */
import { createConnection, type Socket } from "node:net";
import { connectInternalConnection } from "./internal-channel.ts";
import { attachJsonlLineReader, MAX_RPC_LINE_CHARACTERS } from "./jsonl.ts";
import { resolveSocketTransportAddress, sendSocketHandshake } from "./socket-transport.ts";

/**
 * One sealed readiness probe: the internal handshake and the ready reply together, on one monotonic timer (senpi#3816
 * review). A child that accepts the hop and stays silent that long is not a working host, so readiness fails at once
 * instead of hanging the supervisor; a host that is not listening yet is retried until the overall deadline.
 */
export const INTERNAL_READINESS_PROBE_MS = 10_000;

export async function waitForListener(
	socketPath: string,
	timeoutMs: number,
	secret?: Uint8Array,
	internalKey?: Buffer,
	/** A coordinated start retries a silent probe on a fresh connection; its launcher decides expiry (senpi#4602). */
	options: { readonly retrySilent?: boolean } = {},
): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() <= deadline) {
		const probeMs = Math.max(1, Math.min(INTERNAL_READINESS_PROBE_MS, deadline - performance.now()));
		const probe = await canConnect(socketPath, secret, internalKey, probeMs);
		if (probe === "ready") return;
		if (probe === "silent" && !options.retrySilent)
			throw new Error(
				`${socketPath}: host accepted the internal hop but did not answer within ${Math.round(probeMs)}ms`,
			);
		// A host that answered but could not prove the key will not start proving it: fail now, and say why.
		if (probe !== "refused" && probe !== "silent") throw new Error(`${socketPath}: ${probe.unproven}`);
		await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
	}
	throw new Error(`${socketPath}: host did not start listening within ${timeoutMs}ms`);
}

async function canConnect(
	socketPath: string,
	secret: Uint8Array | undefined,
	internalKey: Buffer | undefined,
	probeMs: number,
): Promise<"ready" | "refused" | "silent" | { readonly unproven: "host_identity_unproven" | "auth_failed" }> {
	if (internalKey) {
		const socket = createConnection(resolveSocketTransportAddress(socketPath, process.platform, secret));
		let accepted = false;
		let expired = false;
		socket.once("connect", () => {
			accepted = true;
		});
		// Destroying the socket ends the handshake or the ready wait, whichever is running, and drops the connection.
		const timer = setTimeout(() => {
			expired = true;
			socket.destroy();
		}, probeMs);
		timer.unref();
		const outcome = (ready: boolean) => (ready ? "ready" : accepted && expired ? "silent" : "refused");
		try {
			const stream = await connectInternalConnection(socket, internalKey);
			return outcome(
				await new Promise<boolean>((resolve) => {
					const settle = (ready: boolean) => {
						stream.destroy();
						resolve(ready);
					};
					stream.once("error", () => settle(false));
					stream.once("close", () => settle(false));
					attachJsonlLineReader(
						stream,
						(line) => {
							try {
								const response = JSON.parse(line);
								if (response.id === "internal-ready") settle(response.success === true);
							} catch {
								settle(false);
							}
						},
						{ maxLineLength: MAX_RPC_LINE_CHARACTERS },
					);
					stream.write('{"id":"internal-ready","type":"get_protocol_info","observe":true}\n');
				}),
			);
		} catch (cause) {
			socket.destroy();
			const reason = cause instanceof Error ? cause.message : "";
			if (reason === "host_identity_unproven" || reason === "auth_failed") return { unproven: reason };
			return outcome(false);
		} finally {
			clearTimeout(timer);
		}
	}
	return new Promise((resolve) => {
		const socket: Socket = createConnection(resolveSocketTransportAddress(socketPath, process.platform, secret));
		if (secret) sendSocketHandshake(socket, secret);
		const settle = (connected: boolean): void => {
			socket.destroy();
			resolve(connected ? "ready" : "refused");
		};
		socket.once("connect", () => settle(true));
		socket.once("error", () => settle(false));
	});
}
