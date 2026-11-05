/**
 * One schema per inbound RPC record type, and the validator built from it (senpi#4324).
 *
 * The record is exhaustive over `RpcMethodType` and checked against the TypeScript record types at compile time: a
 * schema must accept every record its type allows (so no well-typed record is refused) and name exactly that type's
 * fields, with the same ones required. Unknown fields stay accepted, as they are on the local connection, so
 * additive fields keep working against older hosts. Typed fields are bounded (`RPC_INBOUND_LIMITS`); the whole record
 * (unknown additive fields and free-form payloads included) is bounded by the host's own line limit, measured as its
 * JSON.
 *
 * Nothing runs this validator yet: the local connection keeps parsing records as it always has, and where a forwarded
 * record is validated (and whether the package root exports it) is still to be decided.
 */

import type { Static, TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import { MAX_RPC_LINE_CHARACTERS } from "./jsonl.ts";
import type { RpcInboundRecordOf, RpcMethodType } from "./method-classes.ts";
import { HOST_RECORD_SCHEMAS } from "./method-classes-schema-host.ts";
import { RECOVERY_RECORD_SCHEMAS } from "./method-classes-schema-recovery.ts";
import { SESSION_RECORD_SCHEMAS } from "./method-classes-schema-session.ts";
import {
	rpcCommandPayloadError,
	rpcCommandShapeError,
	rpcMessageLengthError,
	sessionContextError,
	sessionRetryFallbackError,
} from "./rpc-input-validation.ts";
import { sessionEnvShapeError } from "./session-caller-env.ts";

export { RPC_INBOUND_LIMITS, RPC_QUESTION_ANSWER_LIMITS } from "./method-classes-schema-fields.ts";

/** A schema for every inbound record type. */
export type RpcInboundSchemaTable = { readonly [K in RpcMethodType]: TSchema };

type KeysOf<T> = T extends unknown ? keyof T : never;
type RequiredKeysOf<T> = T extends unknown
	? { [P in keyof T]-?: Record<never, never> extends Pick<T, P> ? never : P }[keyof T]
	: never;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Agrees<R, S> = [R] extends [S]
	? Same<KeysOf<R>, KeysOf<S>> extends true
		? Same<RequiredKeysOf<R>, RequiredKeysOf<S>>
		: false
	: false;

/** The record types whose schema in `Schemas` disagrees with the TypeScript record type (`never` when none does). */
export type RpcInboundSchemaDisagreements<Schemas extends RpcInboundSchemaTable> = {
	[K in RpcMethodType]: Agrees<RpcInboundRecordOf<K>, Static<Schemas[K]>> extends true ? never : K;
}[RpcMethodType];

type AgreementProof<Schemas extends RpcInboundSchemaTable> = [RpcInboundSchemaDisagreements<Schemas>] extends [never]
	? unknown
	: { readonly schemaDisagreesWithRecordType: RpcInboundSchemaDisagreements<Schemas> };

/** Fails the typecheck, naming the type, when a schema is missing or disagrees with its record type. */
function agreeingSchemas<const Schemas extends RpcInboundSchemaTable>(
	schemas: Schemas & AgreementProof<Schemas>,
): Schemas {
	return schemas;
}

export const RPC_INBOUND_SCHEMAS = agreeingSchemas({
	...HOST_RECORD_SCHEMAS,
	...SESSION_RECORD_SCHEMAS,
	...RECOVERY_RECORD_SCHEMAS,
});

export type RpcInboundValidation = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const MAX_REASON_TYPE_CHARACTERS = 64;

function refuse(reason: string): RpcInboundValidation {
	return { ok: false, reason };
}

/** Bounds the schema leaves to the host's own field validators, so both paths refuse the same values. */
function fieldBoundsError(record: Record<string, unknown>): string | undefined {
	const payload = rpcCommandPayloadError(record) ?? rpcMessageLengthError(record);
	if (payload !== undefined) return payload;
	if (record.type === "open_session" || record.type === "warm") {
		const context = sessionContextError(record.context);
		if (context !== undefined) return context;
	}
	if (record.type === "open_session")
		return sessionRetryFallbackError(record.retryFallback) ?? sessionEnvShapeError(record.env);
	if (record.type === "set_retry_fallback") return sessionRetryFallbackError(record.retryFallback);
	return undefined;
}

/**
 * Whether a caller other than the local interactive user may pass `record` on: an object whose `type` has a
 * schema, that matches it, and whose fields are inside the bounds the host enforces. A refusal names the type and
 * the first failing field, never a field's value.
 */
export function validateRpcInboundRecord(record: unknown): RpcInboundValidation {
	const shape = rpcCommandShapeError(record);
	if (shape !== undefined) return refuse(shape);
	// This serializes the record once to measure it; a caller that already holds the raw line may cap that instead.
	let size: number;
	try {
		size = JSON.stringify(record).length;
	} catch {
		return refuse("the record is not JSON-serializable.");
	}
	if (size > MAX_RPC_LINE_CHARACTERS)
		return refuse(`the record is ${size} characters of JSON, at most ${MAX_RPC_LINE_CHARACTERS}.`);
	const value = record as Record<string, unknown>;
	const type = value.type;
	if (typeof type !== "string") return refuse("type must be a string.");
	if (!Object.hasOwn(RPC_INBOUND_SCHEMAS, type)) {
		const shown = type.length > MAX_REASON_TYPE_CHARACTERS ? `${type.slice(0, MAX_REASON_TYPE_CHARACTERS)}...` : type;
		return refuse(`unknown record type: ${JSON.stringify(shown)}.`);
	}
	const schema: TSchema = RPC_INBOUND_SCHEMAS[type as RpcMethodType];
	if (!Check(schema, record)) {
		const [first] = Errors(schema, record);
		const at = first?.instancePath ? ` at ${first.instancePath}` : "";
		return refuse(`${type}: does not match its schema${at}${first ? `: ${first.message}` : ""}.`);
	}
	const bounds = fieldBoundsError(value);
	return bounds === undefined ? { ok: true } : refuse(`${type}: ${bounds}`);
}
