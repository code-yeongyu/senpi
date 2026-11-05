import type { ImageContent, JsonValue, TextContent } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "../types.ts";
import { DEVICE_FILE_OPS, type DeviceFileOp } from "./device-files.ts";
import type { ExecutionScope } from "./tool-host.ts";

/**
 * The wire messages between a session's remote ToolHost and the hand that runs its tool calls (brain/hand split, S27a).
 * One transport lane per execution scope; a transport never inspects these payloads.
 *
 * The hand receives the model's raw call (name and arguments, before preparation, validation and hooks) and runs all of
 * those steps itself. `sessionRef` is what the session chose to say about itself: the hand passes it to nothing.
 */
export type RemoteHandMessage =
	| RemoteInvoke
	| RemoteAbort
	| RemoteAck
	| RemoteSettled
	| RemoteTerminal
	| RemoteRefused
	| RemoteHello
	| RemoteFile;

/** The lane a hand announces itself on; execution scope lanes carry everything else. */
export const HAND_CONTROL_LANE = "hand.control";

/**
 * Every hand announces itself once per process start (after re-sending the outcomes its durable record holds that the
 * session has not acknowledged). Only a `durable` hand gets the calls still waiting re-sent: its record answers a call
 * it already holds and runs only a call whose admission never became durable; a hand without a record would run them
 * again or refuse them as duplicates. `ops` names the channels it serves beside tool calls (`file/1`, S40). An older
 * hand sends neither field and announces itself only with a record, so it reads as durable with no channels.
 */
export interface RemoteHello {
	readonly kind: "hello";
	readonly instance: string;
	readonly durable: boolean;
	readonly ops: readonly string[];
}

/**
 * One device file operation (S40), a message kind of its own: the tool host never sends it, and an `invoke` named like
 * an operation is an unknown tool. It shares the invoke's admission (lane, grant, scope binding, execution ID) and is
 * answered like a call (`settled` with the outcome in `details.file`, `refused`, `terminal`).
 */
export interface RemoteFile {
	readonly kind: "file";
	readonly executionId: string;
	readonly scope: ExecutionScope;
	readonly op: DeviceFileOp;
	readonly args: JsonValue;
}

export interface RemoteInvoke {
	readonly kind: "invoke";
	/** Unique per call per session; a hand runs one execution ID at most once. */
	readonly executionId: string;
	readonly batchId: string;
	/** Position in the batch, in the model's source order. */
	readonly index: number;
	readonly scope: ExecutionScope;
	readonly toolCallId: string;
	readonly name: string;
	readonly arguments: unknown;
	readonly sessionRef?: string;
}

export interface RemoteAbort {
	readonly kind: "abort";
	readonly executionId: string;
}

/** The session has its outcome: the hand may forget it (a later replay is `result_expired`). */
export interface RemoteAck {
	readonly kind: "ack";
	readonly executionId: string;
}

/** The reasons a call can end on a hand without a tool result (the endpoint state machine's terminal reasons). */
export type RemoteTerminalReason = "cancelled" | "lease_expired" | "hand_restarted" | "uncertain";

/**
 * The call ended without a tool result, for example because the hand restarted while it ran. `uncertain` says its
 * effects may have happened; `hooksRan` says its `tool_call` handlers may have run. It is never run again.
 */
export interface RemoteTerminal {
	readonly kind: "terminal";
	readonly executionId: string;
	readonly reason: RemoteTerminalReason;
	readonly uncertain: boolean;
	readonly hooksRan: boolean;
}

/** The call ran to an outcome on the hand (an `isError` result included: a blocked, invalid or failing call). */
export interface RemoteSettled {
	readonly kind: "settled";
	readonly executionId: string;
	readonly result: RemoteToolResult;
}

/** The hand refused the call before anything ran (duplicate execution, scope binding, an unopenable scope). */
export interface RemoteRefused {
	readonly kind: "refused";
	readonly executionId: string;
	readonly reason: string;
}

/** The serializable part of an {@link AgentToolResult}. */
export interface RemoteToolResult {
	readonly content: (TextContent | ImageContent)[];
	readonly details: JsonValue | undefined;
	readonly isError: boolean;
	readonly structuredContent?: JsonValue;
	readonly terminate?: boolean;
	readonly addedToolNames?: readonly string[];
}

export class RemoteProtocolError extends Error {
	constructor(message: string) {
		super(`remote_protocol: ${message}`);
		this.name = "RemoteProtocolError";
	}
}

const TERMINAL_REASONS: readonly RemoteTerminalReason[] = ["cancelled", "lease_expired", "hand_restarted", "uncertain"];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeRemoteMessage(message: RemoteHandMessage): Uint8Array {
	return encoder.encode(JSON.stringify(message));
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** Parses one frame payload. Anything that is not exactly one of the messages is refused; nothing guesses. */
export function decodeRemoteMessage(payload: Uint8Array): RemoteHandMessage {
	let value: unknown;
	try {
		value = JSON.parse(decoder.decode(payload));
	} catch {
		throw new RemoteProtocolError("payload is not JSON");
	}
	if (isRecord(value) && value.kind === "hello") {
		const { instance, durable, ops } = value;
		if (!isString(instance)) throw new RemoteProtocolError("malformed hello");
		if (durable !== undefined && typeof durable !== "boolean") throw new RemoteProtocolError("malformed hello");
		if (ops !== undefined && (!Array.isArray(ops) || !ops.every(isString)))
			throw new RemoteProtocolError("malformed hello");
		return { kind: "hello", instance, durable: durable ?? true, ops: ops ?? [] };
	}
	if (!isRecord(value) || !isString(value.executionId)) throw new RemoteProtocolError("no execution ID");
	switch (value.kind) {
		case "invoke": {
			const scope = value.scope;
			if (
				!isString(value.batchId) ||
				typeof value.index !== "number" ||
				!Number.isSafeInteger(value.index) ||
				value.index < 0 ||
				!isRecord(scope) ||
				!isString(scope.id) ||
				typeof scope.root !== "string" ||
				!isString(value.toolCallId) ||
				!isString(value.name) ||
				(value.sessionRef !== undefined && typeof value.sessionRef !== "string")
			)
				throw new RemoteProtocolError("malformed invoke");
			return value as unknown as RemoteInvoke;
		}
		case "file": {
			const scope = value.scope;
			if (
				!isRecord(scope) ||
				!isString(scope.id) ||
				typeof scope.root !== "string" ||
				!DEVICE_FILE_OPS.includes(value.op as DeviceFileOp) ||
				!isRecord(value.args)
			)
				throw new RemoteProtocolError("malformed file operation");
			return value as unknown as RemoteFile;
		}
		case "abort":
			return value as unknown as RemoteAbort;
		case "ack":
			return value as unknown as RemoteAck;
		case "terminal":
			if (
				!TERMINAL_REASONS.includes(value.reason as RemoteTerminalReason) ||
				typeof value.uncertain !== "boolean" ||
				typeof value.hooksRan !== "boolean"
			)
				throw new RemoteProtocolError("malformed terminal outcome");
			return value as unknown as RemoteTerminal;
		case "settled": {
			const result = value.result;
			if (!isRecord(result) || !Array.isArray(result.content) || typeof result.isError !== "boolean")
				throw new RemoteProtocolError("malformed result");
			return value as unknown as RemoteSettled;
		}
		case "refused":
			if (typeof value.reason !== "string") throw new RemoteProtocolError("malformed refusal");
			return value as unknown as RemoteRefused;
		default:
			throw new RemoteProtocolError("unknown message kind");
	}
}

/** The JSON form a value takes on the wire (what the session receives), so a result's types say what arrives. */
function asJson(value: unknown): JsonValue | undefined {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** What a hand sends back for a tool result, keeping only what crosses the wire. */
export function toRemoteToolResult(result: AgentToolResult<unknown>): RemoteToolResult {
	return {
		content: result.content ?? [],
		details: asJson(result.details),
		isError: result.isError === true,
		...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
		...(result.terminate === undefined ? {} : { terminate: result.terminate }),
		...(result.addedToolNames?.length ? { addedToolNames: [...result.addedToolNames] } : {}),
	};
}
