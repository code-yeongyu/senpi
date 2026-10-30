import { sign } from "node:crypto";
import type { Socket } from "node:net";
import { expect } from "vitest";
import { attachJsonlLineReader } from "../../src/modes/rpc/jsonl.ts";
import { enrollmentKey, enrollmentRequest } from "../mcp/fixtures/presenter-enrollment.ts";
import type { Peer, Wire } from "./rpc-public-auth-harness.ts";

export const enroll = enrollmentRequest();

export function send(socket: Socket, record: object): void {
	socket.write(`${JSON.stringify(record)}\n`);
}

/** Subscribe before sending, including EOF: lost bootstrap fails without waiting for the deadline. */
export function next(socket: Socket, type: string): Promise<Wire> {
	return new Promise((resolve, reject) => {
		const finish = (record?: Wire) => {
			clearTimeout(timer);
			detach();
			socket.off("close", closed);
			socket.off("error", failed);
			if (record) resolve(record);
			else reject(new Error(`presenter channel closed before ${type}`));
		};
		const closed = () => finish();
		const failed = () => finish();
		const detach = attachJsonlLineReader(socket, (line) => {
			const record = JSON.parse(line) as Wire;
			if (record.type === type) finish(record);
		});
		const timer = setTimeout(() => finish(), 60_000);
		socket.once("close", closed);
		socket.once("error", failed);
	});
}

/**
 * Sends a request the host acknowledges with `queued` (`open_session`, senpi#1844; `prompt`) and waits the
 * way RpcClient does (senpi#2209, #2871): the acknowledgement within the peer deadline, then the answer or a
 * lost connection. An acknowledged request has no further wall-clock window, because a loaded in-process host
 * legitimately builds a session for close to a minute; the test timeout bounds a host that goes silent.
 * It reads the records the peer already parsed, waking on the socket's data, so no second line reader
 * ever starts mid-record.
 */
export function acknowledgedRequest(peer: Peer, request: Wire & { readonly id: string }): Promise<Wire> {
	const seen = peer.records.length;
	const failure = (reason: string) =>
		new Error(`${String(request.type)} ${reason}: ${JSON.stringify(peer.records.slice(seen))}`);
	return new Promise<Wire>((resolve, reject) => {
		const finish = (outcome: Wire | Error) => {
			clearTimeout(unacknowledged);
			peer.socket.off("data", check);
			peer.socket.off("close", closed);
			if (outcome instanceof Error) reject(outcome);
			else resolve(outcome);
		};
		// Registered after the peer's own reader, so every complete record of this chunk is already parsed.
		const check = () => {
			const fresh = peer.records.slice(seen);
			const answer = fresh.find((record) => record.type === "response" && record.id === request.id);
			if (answer) finish(answer);
			else if (fresh.some((record) => record.type === "queued" && record.for_request === request.id))
				clearTimeout(unacknowledged);
		};
		const unacknowledged = setTimeout(
			() => finish(failure(`was not acknowledged within ${peer.deadlineMs} ms`)),
			peer.deadlineMs,
		);
		const closed = () => finish(failure("lost its connection before the answer"));
		peer.socket.on("data", check);
		peer.socket.once("close", closed);
		send(peer.socket, request);
	});
}

export function signature(transcript: unknown): string {
	if (typeof transcript !== "string") throw new Error("missing enrollment transcript");
	return sign(null, Buffer.from(transcript), enrollmentKey.privateKey).toString("hex");
}

export async function bootstrap(socket: Socket, predecessor: unknown = null): Promise<Wire> {
	const request = enrollmentRequest({
		launchKind: predecessor === null ? "initial" : "replacement",
		predecessorHostInstance: predecessor,
	});
	const challenge = next(socket, "challenge");
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
	const enrolled = next(socket, "enrolled");
	send(socket, { type: "proof", signature: proof });
	const acknowledgement = await enrolled;
	expect(acknowledgement).toMatchObject({
		version: 2,
		launchRequestNonce: request.launchRequestNonce,
		hostInstance: received.hostInstance,
	});
	return acknowledgement;
}
