import type { ImageContent, JsonValue, TextContent } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "../types.ts";
import type { ExecutionScope } from "./tool-host.ts";

/**
 * The wire messages between a session's remote ToolHost and the hand that runs its tool calls (brain/hand split, S27a).
 * One transport lane per execution scope; a transport never inspects these payloads.
 *
 * The hand receives the model's raw call (name and arguments, before preparation, validation and hooks) and runs all of
 * those steps itself. `sessionRef` is what the session chose to say about itself: the hand passes it to nothing.
 */
export type RemoteHandMessage = RemoteInvoke | RemoteAbort | RemoteSettled | RemoteRefused;

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
		case "abort":
			return value as unknown as RemoteAbort;
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
