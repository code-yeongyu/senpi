/**
 * Shared records of the `machine_op` suites (senpi#6752): the engine runs one device operation for the local relay
 * host on a launch-proven, non-delegated connection and answers the relay host's `OpOutcome` unchanged.
 */
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { Peer, WireRecord } from "./rpc-delegated-host-support.ts";

export const SENDER = "device-6752";
const OP_BUDGET_MS = 30_000;

export interface MachineOpOptions {
	readonly root: string;
	readonly confined?: boolean;
	readonly opId?: string;
	readonly deadlineMs?: number;
	readonly sender?: string;
}

export function machineOpRecord(op: string, args: WireRecord, options: MachineOpOptions): WireRecord {
	return {
		type: "machine_op",
		op,
		args,
		op_id: options.opId ?? `${op}-${randomUUID()}`,
		deadline_ms: options.deadlineMs ?? Date.now() + OP_BUDGET_MS,
		scope: { root: options.root, confined: options.confined ?? false },
		sender: options.sender ?? SENDER,
	};
}

export function runOp(peer: Peer, op: string, args: WireRecord, options: MachineOpOptions): Promise<WireRecord> {
	return peer.send(machineOpRecord(op, args, options));
}

export function answered(command: string, data: unknown): WireRecord {
	return { id: expect.any(String), type: "response", command, success: true, data };
}

export function outcome(data: unknown): WireRecord {
	return answered("machine_op", data);
}

export function notAuthorized(command: string): WireRecord {
	return {
		id: expect.any(String),
		type: "response",
		command,
		success: false,
		error: `machine_op_not_authorized: ${command} needs a connection that proved the endpoint's launch key and declared no delegation`,
		errorCode: "machine_op_not_authorized",
	};
}

export function base64(text: string): string {
	return Buffer.from(text).toString("base64");
}
