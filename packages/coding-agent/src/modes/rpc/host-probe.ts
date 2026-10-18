/**
 * One question asked over a shared RPC socket: "who is serving this endpoint, and what is it holding?"
 *
 * Every client decision - attach, refuse, hand off, stop - starts here, and the answer is always
 * the host's own reply rather than anything a caller recorded earlier: files describe the past,
 * the socket describes the present. A probe never throws for an absent or silent endpoint,
 * because "nobody is there" is a legitimate answer that callers act on; a malformed answer is
 * dropped for the same reason.
 */
import { createConnection, type Socket } from "node:net";
import { type HostAttachHold, holdAttachment } from "./host-attach-hold.ts";
import { type HostProtocolInfo, parseHostProtocolInfo } from "./host-decision.ts";
import { OBSERVE_REQUEST_FIELD } from "./host-observe-request.ts";
import {
	readSocketSecret,
	resolveSocketTransportAddress,
	sendSocketHandshake,
	socketSecretPath,
} from "./socket-transport.ts";
import { socketNeedsHandshake } from "./tui-socket.ts";

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

/** `probeProtocolInfo` for a read that must not count as host activity, such as `host status`. */
export async function observeProtocolInfo(
	socketPath: string,
	timeoutMs: number,
): Promise<HostProtocolInfo | undefined> {
	const reply = await requestOnSocket(
		socketPath,
		{ type: "get_protocol_info", [OBSERVE_REQUEST_FIELD]: true },
		timeoutMs,
	);
	return reply === undefined ? undefined : parseHostProtocolInfo(reply);
}

/**
 * The host's identity together with an attach hold on the connection that answered, or `undefined`
 * when nothing answers. The answer and the claim share one connection, so there is no instant
 * between "the host is ready" and "the host is held" in which an idle window could close.
 */
export async function holdProtocolInfo(
	socketPath: string,
	timeoutMs: number,
): Promise<{ readonly info: HostProtocolInfo; readonly hold: HostAttachHold } | undefined> {
	const outcome = await connectAndAsk(
		socketPath,
		{ id: PROBE_REQUEST_ID, type: "get_protocol_info" },
		timeoutMs,
		true,
	);
	const info = outcome.answer === undefined ? undefined : parseHostProtocolInfo(outcome.answer);
	if (outcome.kept === undefined) return undefined;
	const hold = holdAttachment(outcome.kept);
	if (info !== undefined) return { info, hold };
	hold.release();
	return undefined;
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
	return sessionCountOf(
		await requestOnSocket(socketPath, { type: "list_sessions", include_workers: true }, timeoutMs),
	);
}

/**
 * The session count together with the connection that answered it, kept open so the SAME host can be
 * asked again after its public path was handed to somebody else: the recount reaches the process that
 * was counted, never whoever serves the path by then. `undefined` when the host does not answer.
 */
export interface HeldSessionCount {
	readonly sessions: number;
	/** Asks the counted host again over the held connection; `undefined` when it no longer answers. */
	recount(timeoutMs: number): Promise<number | undefined>;
	close(): void;
}

export async function holdSessionCount(socketPath: string, timeoutMs: number): Promise<HeldSessionCount | undefined> {
	const outcome = await connectAndAsk(
		socketPath,
		{ id: PROBE_REQUEST_ID, type: "list_sessions", include_workers: true },
		timeoutMs,
		true,
	);
	const kept = outcome.kept;
	if (kept === undefined) return undefined;
	const sessions = sessionCountOf(outcome.answer);
	if (sessions === undefined) {
		kept.destroy();
		return undefined;
	}
	let asked = 0;
	return {
		sessions,
		recount: (recountTimeoutMs) => askAgain(kept, `${PROBE_REQUEST_ID}-recount-${++asked}`, recountTimeoutMs),
		close: () => kept.destroy(),
	};
}

function askAgain(socket: Socket, id: string, timeoutMs: number): Promise<number | undefined> {
	return new Promise((resolveCount) => {
		let buffer = "";
		const finish = (count: number | undefined): void => {
			clearTimeout(timeout);
			socket.off("data", onData);
			socket.off("close", onClose);
			resolveCount(count);
		};
		const onClose = (): void => finish(undefined);
		const onData = (chunk: Buffer): void => {
			buffer += chunk.toString("utf8");
			for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
				const answer = readAnswer(buffer.slice(0, newline), id);
				buffer = buffer.slice(newline + 1);
				if (answer !== undefined) {
					finish(sessionCountOf(answer));
					return;
				}
			}
		};
		const timeout = setTimeout(() => finish(undefined), timeoutMs);
		if (socket.destroyed) {
			finish(undefined);
			return;
		}
		socket.on("data", onData);
		socket.once("close", onClose);
		socket.write(`${JSON.stringify({ id, type: "list_sessions", include_workers: true })}\n`);
	});
}

function sessionCountOf(reply: unknown): number | undefined {
	return isRecord(reply) && Array.isArray(reply.sessions) ? reply.sessions.length : undefined;
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
	/** The answering connection, left open, when the caller asked to keep it. */
	readonly kept?: Socket;
}

async function connectAndAsk(
	socketPath: string,
	request: Readonly<Record<string, unknown>>,
	timeoutMs: number,
	keep = false,
): Promise<ProbeOutcome> {
	let secret: Buffer | undefined;
	if (socketNeedsHandshake(socketPath)) {
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
			if (keep && value !== undefined && !socket.destroyed) {
				resolveProbe({ connected, answer: value, kept: socket });
				return;
			}
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

function readAnswer(text: string, id: string = PROBE_REQUEST_ID): unknown {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || parsed.id !== id || parsed.success !== true) return undefined;
	return parsed.data ?? {};
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
