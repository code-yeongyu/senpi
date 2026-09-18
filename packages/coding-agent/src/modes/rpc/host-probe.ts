/**
 * One question asked over a shared RPC socket: "who is serving this endpoint, and what is it holding?"
 *
 * Every client decision - attach, refuse, hand off, stop - starts here, and the answer is always
 * the host's own reply rather than anything a caller recorded earlier: files describe the past,
 * the socket describes the present. A probe never throws for an absent or silent endpoint,
 * because "nobody is there" is a legitimate answer that callers act on; a malformed answer is
 * dropped for the same reason.
 */
import { createConnection } from "node:net";
import { type HostProtocolInfo, parseHostProtocolInfo } from "./host-decision.ts";
import {
	readSocketSecret,
	resolveSocketTransportAddress,
	sendSocketHandshake,
	socketSecretPath,
} from "./socket-transport.ts";

/** Default probe budget: long enough for a host under load, short enough to keep an ensure moving. */
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const PROBE_REQUEST_ID = "ensure-host-probe";

export interface ProbeHostOptions {
	readonly socket: string;
	readonly timeoutMs?: number;
}

/** The running host's identity, or `undefined` when nothing is serving the endpoint. */
export function probeHost(options: ProbeHostOptions): Promise<HostProtocolInfo | undefined> {
	return probeProtocolInfo(options.socket, options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
}

export async function probeProtocolInfo(socketPath: string, timeoutMs: number): Promise<HostProtocolInfo | undefined> {
	const reply = await requestOnSocket(socketPath, { type: "get_protocol_info" }, timeoutMs);
	return reply === undefined ? undefined : parseHostProtocolInfo(reply);
}

/**
 * Whether the socket ACCEPTED a connection during the last probe, regardless of whether an answer
 * arrived in time. A host under load can miss a probe budget while it is perfectly alive, and the
 * difference decides whether an ensure may end it: a silent-but-connectable socket has an owner
 * serving sessions behind it, and killing that owner destroys every one of them.
 */
export async function probeSocketReachable(socketPath: string, timeoutMs: number): Promise<boolean> {
	return (await connectAndAsk(socketPath, { id: PROBE_REQUEST_ID, type: "get_protocol_info" }, timeoutMs)).connected;
}

/**
 * How many sessions the host holds right now, worker sessions included, or `undefined` when it
 * does not answer. A stop decision needs the number the host reports, not the one a client remembers.
 */
export async function probeSessionCount(socketPath: string, timeoutMs: number): Promise<number | undefined> {
	const reply = await requestOnSocket(socketPath, { type: "list_sessions", include_workers: true }, timeoutMs);
	if (!isRecord(reply) || !Array.isArray(reply.sessions)) return undefined;
	return reply.sessions.length;
}

/** Sends one command and returns its `data`, or `undefined` for any failure to get a usable answer. */
export async function requestOnSocket(
	socketPath: string,
	command: Readonly<Record<string, unknown>>,
	timeoutMs: number,
): Promise<unknown> {
	return (await connectAndAsk(socketPath, { id: PROBE_REQUEST_ID, ...command }, timeoutMs)).answer;
}

/** One probe's outcome: whether the socket accepted a connection, and the answer if one arrived. */
interface ProbeOutcome {
	readonly connected: boolean;
	readonly answer: unknown;
}

async function connectAndAsk(
	socketPath: string,
	request: Readonly<Record<string, unknown>>,
	timeoutMs: number,
): Promise<ProbeOutcome> {
	let secret: Buffer | undefined;
	if (process.platform === "win32") {
		try {
			secret = await readSocketSecret(socketSecretPath(socketPath));
		} catch {
			return { connected: false, answer: undefined };
		}
	}
	return new Promise((resolveProbe) => {
		const socket = createConnection(resolveSocketTransportAddress(socketPath, process.platform, secret));
		let buffer = "";
		let settled = false;
		let connected = false;
		const finish = (value?: unknown): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			socket.destroy();
			resolveProbe({ connected, answer: value });
		};
		const timeout = setTimeout(() => finish(), timeoutMs);
		socket.once("connect", () => {
			connected = true;
			socket.write(`${JSON.stringify(request)}\n`);
		});
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline === -1) return;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				// A host broadcasts lifecycle records to every connection, so the reply to THIS
				// request is the line carrying its id - not simply the first line that arrives.
				const answer = readAnswer(line);
				if (answer !== undefined) return finish(answer);
			}
		});
		socket.once("error", () => finish());
		socket.once("close", () => finish());
		// Register the error listener before sending the Windows named-pipe handshake.
		// When an idle host has already removed its pipe, the handshake write can
		// surface ENOENT immediately; without the listener this probe escapes instead
		// of becoming the expected "no existing host" result for the next ensure.
		if (secret) sendSocketHandshake(socket, secret);
	});
}

function readAnswer(text: string): unknown {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || parsed.id !== PROBE_REQUEST_ID || parsed.success !== true) return undefined;
	return parsed.data ?? {};
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
