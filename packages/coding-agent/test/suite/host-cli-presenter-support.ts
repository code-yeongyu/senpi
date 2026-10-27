import { sign } from "node:crypto";
import type { Socket } from "node:net";
import { expect } from "vitest";
import { attachJsonlLineReader } from "../../src/modes/rpc/jsonl.ts";
import { enrollmentKey, enrollmentRequest } from "../mcp/fixtures/presenter-enrollment.ts";
import type { Wire } from "./rpc-public-auth-harness.ts";

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
