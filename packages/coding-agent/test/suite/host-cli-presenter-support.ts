import { randomBytes, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { join } from "node:path";
import { expect } from "vitest";
import { attachJsonlLineReader } from "../../src/modes/rpc/jsonl.ts";
import { enrollmentKey, enrollmentRequest } from "../mcp/fixtures/presenter-enrollment.ts";
import { type Peer, proof, type Wire } from "./rpc-public-auth-harness.ts";

export const enroll = enrollmentRequest();

export function send(socket: Socket, record: object): void {
	socket.write(`${JSON.stringify(record)}\n`);
}

/**
 * Every wait in these files ends on something the host or the channel does, never on a wall-clock window
 * of its own (senpi#4587, #4652): the awaited record, the channel's close or error ("closed before"), or
 * the end of the test ("still waiting", with the channel still open). A loaded host legitimately takes
 * longer than any fixed window to finish a turn, start a successor and announce it; the test timeout
 * bounds a host that goes silent, and `signal` is that test's own (vitest aborts it when the test ends).
 */
function stillWaiting(signal: AbortSignal, ended: () => Error, finish: (error: Error) => void): () => void {
	// vitest reports its own timeout error and drops this rejection, so the pending wait is also written out.
	const onEnd = () => {
		const error = ended();
		process.stderr.write(`${error.message}\n`);
		finish(error);
	};
	if (signal.aborted) {
		queueMicrotask(onEnd);
		return () => {};
	}
	signal.addEventListener("abort", onEnd, { once: true });
	return () => signal.removeEventListener("abort", onEnd);
}

/** Subscribe before sending, including EOF: lost bootstrap fails at once. */
export function next(socket: Socket, type: string, signal: AbortSignal): Promise<Wire> {
	return new Promise((resolve, reject) => {
		const seen: unknown[] = [];
		const failure = (reason: string) => new Error(`${reason}; records since the wait began: ${JSON.stringify(seen)}`);
		const finish = (outcome: Wire | Error) => {
			detach();
			unwatch();
			socket.off("close", closed);
			socket.off("error", failed);
			if (outcome instanceof Error) reject(outcome);
			else resolve(outcome);
		};
		const closed = () => finish(failure(`presenter channel closed before ${type}`));
		const failed = (cause: Error) => finish(failure(`presenter channel failed before ${type}: ${cause.message}`));
		const detach = attachJsonlLineReader(socket, (line) => {
			const record = JSON.parse(line) as Wire;
			if (record.type === type) finish(record);
			else seen.push(record.type);
		});
		const unwatch = stillWaiting(
			signal,
			() => failure(`still waiting for ${type} when the test ended; the presenter channel is open`),
			finish,
		);
		socket.once("close", closed);
		socket.once("error", failed);
	});
}

/** A refused channel may reset with unread records; require close after either reset or EOF. */
export function hostCloses(socket: Socket, what: string, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const finish = (error?: Error) => {
			unwatch();
			socket.off("close", closed);
			socket.off("error", failed);
			if (error) reject(error);
			else resolve();
		};
		const closed = () => finish();
		const failed = (cause: NodeJS.ErrnoException) => {
			if (cause.code !== "ECONNRESET")
				finish(new Error(`${what} failed before the host closed it: ${cause.message}`));
		};
		const unwatch = stillWaiting(
			signal,
			() => new Error(`still waiting for the host to close ${what} when the test ended; it is open`),
			finish,
		);
		socket.once("close", closed);
		socket.once("error", failed);
	});
}

/**
 * The channel's own `connect`, or its connection error. A local-socket connect completes in the kernel's
 * listen backlog without the host's loop, and a missing or refusing endpoint errors at once, so there is no
 * host event a promptness bound could anchor to; the error is the failure.
 */
export function connected(socket: Socket, what: string, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const finish = (error?: Error) => {
			unwatch();
			socket.off("connect", done);
			socket.off("error", failed);
			if (error) reject(error);
			else resolve();
		};
		const done = () => finish();
		const failed = (cause: Error) => finish(new Error(`${what} did not connect: ${cause.message}`));
		const unwatch = stillWaiting(signal, () => new Error(`still connecting to ${what} when the test ended`), finish);
		socket.once("connect", done);
		socket.once("error", failed);
	});
}

/**
 * A record the peer's own reader parses (no second line reader ever starts mid-record), from the first
 * one after `since`: it wakes on the socket's data, registered after the peer's reader, so every complete
 * record of a chunk is already parsed. It ends with the record, the connection's close, or the test.
 */
export function peerRecord(
	peer: Peer,
	predicate: (record: Wire) => boolean,
	what: string,
	signal: AbortSignal,
	since = peer.records.length,
	progress: (fresh: readonly Wire[]) => string = () => "",
): Promise<Wire> {
	const failure = (reason: string) =>
		new Error(`${reason}; records since the wait began: ${JSON.stringify(peer.records.slice(since))}`);
	return new Promise<Wire>((resolve, reject) => {
		const finish = (outcome: Wire | Error) => {
			unwatch();
			peer.socket.off("data", check);
			peer.socket.off("close", closed);
			if (outcome instanceof Error) reject(outcome);
			else resolve(outcome);
		};
		const check = () => {
			const found = peer.records.slice(since).find(predicate);
			if (found) finish(found);
		};
		const closed = () => finish(failure(`connection closed before ${what}`));
		const unwatch = stillWaiting(
			signal,
			() =>
				failure(
					`still waiting for ${what} when the test ended${progress(peer.records.slice(since))}; the connection is open`,
				),
			finish,
		);
		peer.socket.on("data", check);
		peer.socket.once("close", closed);
		check();
		if (peer.socket.destroyed) closed();
	});
}

/**
 * Sends a request the host acknowledges with `queued` (`open_session`, senpi#1844; `prompt`) and waits for
 * its answer or a lost connection (senpi#4587). An acknowledged request has no wall-clock window, because a
 * loaded in-process host legitimately builds a session for close to a minute. The acknowledgement is
 * asserted by order instead: the host writes `queued` for the request before it handles it
 * (`session-router-open.ts`, `session-held.ts`), so an answer with no `queued` before it fails.
 */
export async function acknowledgedRequest(
	peer: Peer,
	request: Wire & { readonly id: string },
	signal: AbortSignal,
): Promise<Wire> {
	const since = peer.records.length;
	const acknowledges = (record: Wire) => record.type === "queued" && record.for_request === request.id;
	const answered = peerRecord(
		peer,
		(record) => record.type === "response" && record.id === request.id,
		`the ${String(request.type)} answer`,
		signal,
		since,
		(fresh) => (fresh.some(acknowledges) ? " (acknowledged)" : " (never acknowledged)"),
	);
	send(peer.socket, request);
	const answer = await answered;
	const beforeAnswer = peer.records.slice(since, peer.records.indexOf(answer));
	if (!beforeAnswer.some(acknowledges))
		throw new Error(
			`${String(request.type)} was answered without a queued acknowledgement before it: ${JSON.stringify(beforeAnswer)}`,
		);
	return answer;
}

/** `authenticate` from the auth harness, with event-bounded waits: the protocol challenge, then the proof. */
export async function authenticated(peer: Peer, agentDir: string, signal: AbortSignal): Promise<Wire> {
	const nonce = randomBytes(32).toString("hex");
	const offered = peerRecord(peer, (record) => record.id === "protocol", "the protocol challenge", signal);
	send(peer.socket, { type: "get_protocol_info", id: "protocol", observe: true, auth: { client_nonce: nonce } });
	const auth = ((await offered).data as Wire | undefined)?.auth as
		| { launch_id: string; server_nonce: string; server_proof: string }
		| undefined;
	if (auth === undefined) throw new Error("host did not offer authentication");
	const record = JSON.parse(await readFile(join(agentDir, "rpc", "keys", auth.launch_id), "utf8"));
	const key = Buffer.from(record.key, "hex");
	if (auth.server_proof !== proof(key, "senpi-rpc-server", auth.launch_id, nonce, auth.server_nonce))
		throw new Error("invalid server proof");
	const answer = peerRecord(peer, (record) => record.id === "authenticate", "the authenticate answer", signal);
	send(peer.socket, {
		type: "authenticate",
		id: "authenticate",
		client_proof: proof(key, "senpi-rpc-client", auth.launch_id, auth.server_nonce, nonce),
	});
	return answer;
}

export function signature(transcript: unknown): string {
	if (typeof transcript !== "string") throw new Error("missing enrollment transcript");
	return sign(null, Buffer.from(transcript), enrollmentKey.privateKey).toString("hex");
}

export async function bootstrap(socket: Socket, signal: AbortSignal, predecessor: unknown = null): Promise<Wire> {
	const request = enrollmentRequest({
		launchKind: predecessor === null ? "initial" : "replacement",
		predecessorHostInstance: predecessor,
	});
	const challenge = next(socket, "challenge", signal);
	send(socket, request);
	const received = await challenge;
	// #4254: the real launch chain signs the fixed tuple and acknowledges the same launch.
	expect(received.version).toBe(2);
	const tuple = JSON.parse(String(received.transcript));
	expect(tuple[4]).toBe(request.launchRequestNonce);
	expect(tuple[5]).toBe(request.launchKind);
	expect(tuple[6]).toBe(predecessor);
	expect(tuple[9]).toBe(received.hostInstance);
	expect(tuple).toHaveLength(12);
	const proof = signature(received.transcript);
	const enrolled = next(socket, "enrolled", signal);
	send(socket, { type: "proof", signature: proof });
	const acknowledgement = await enrolled;
	expect(acknowledgement).toMatchObject({
		version: 2,
		launchRequestNonce: request.launchRequestNonce,
		hostInstance: received.hostInstance,
	});
	return acknowledgement;
}
