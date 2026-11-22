import type { StoreValue } from "../../durable/store.ts";
import type { AgentToolResult } from "../../types.ts";
import { canonicalDigest } from "../canonical-digest.ts";
import type { FrozenCall } from "../ledger-types.ts";
import { type BodyOutcome, errorResult, messageOf } from "./executor-body.ts";
import type { PrepareReply } from "./executor-types.ts";

/** Tool arguments and results are JSON on every model and wire path; a round trip drops what JSON cannot carry. */
export function toStoreValue(value: unknown): StoreValue {
	const json = JSON.stringify(value);
	return json === undefined ? null : JSON.parse(json);
}

/** The call after the whole `tool_call` chain, detached from every object a handler or caller still holds. */
export async function freezeCall(name: string, args: unknown): Promise<FrozenCall> {
	const frozenArgs = toStoreValue(args);
	return { name, args: frozenArgs, digest: await canonicalDigest({ name, args: frozenArgs }) };
}

/** The durable record of a settled body: what the issuer commits before ACK. Details stay in the in-process reply. */
function resultValue(result: AgentToolResult<unknown>, isError: boolean, requestedName?: string): StoreValue {
	return toStoreValue({ content: result.content ?? [], isError, requestedName });
}

/**
 * A settled body and its durable record. Content JSON cannot carry (an untyped tool breaking the content contract) settles
 * the call as a tool error naming the problem, never as a rejection of the whole release (senpi#5864).
 */
export function recordedResult(
	outcome: BodyOutcome,
	requestedName: string | undefined,
): BodyOutcome & { readonly value: StoreValue } {
	try {
		return { ...outcome, value: resultValue(outcome.result, outcome.isError, requestedName) };
	} catch (error) {
		const result = errorResult(`Tool result content is not JSON: ${messageOf(error)}`);
		return { result, isError: true, value: resultValue(result, true, requestedName) };
	}
}

export type StoppedReply = Extract<PrepareReply, { readonly kind: "blocked" | "batch_abort" }>;

/** A preparation that ended without a frozen call, as the ledger's durable `blocked` outcome value. */
export function stoppedValue(reply: StoppedReply): StoreValue {
	const text = (reply.result.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
	const requestedName = reply.kind === "blocked" ? reply.requestedName : undefined;
	return toStoreValue({ kind: reply.kind, text, terminate: reply.result.terminate === true, requestedName });
}

/** The reply a re-sent prepare gets back from a durable `blocked` outcome; undefined for a value this module never wrote. */
function isRecord(value: StoreValue): value is { readonly [key: string]: StoreValue } {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function stoppedReply(value: StoreValue): StoppedReply | undefined {
	if (!isRecord(value)) return undefined;
	const { kind, text, terminate, requestedName } = value;
	if (typeof text !== "string" || typeof terminate !== "boolean") return undefined;
	const result = errorResult(text);
	if (terminate) result.terminate = true;
	if (kind === "batch_abort") return { kind, result };
	if (kind !== "blocked") return undefined;
	return typeof requestedName === "string" ? { kind, result, requestedName } : { kind, result };
}
