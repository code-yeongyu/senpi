/**
 * Schema of the brain's `egress_call` ledger (row CK9; custody design 4.5, 2.3, 4.2, 15.7). One row per dialed model
 * call with its admitted request stored beside it in 96 KiB chunks, the step-cancelled marker (W14), and the
 * per-session device variants (`session/variants`, read by the route). Every value here is written by `ledger.ts`
 * through the host's admitted mutations; this module only names keys and converts rows to and from store values.
 */
import type { DeviceId, ProviderId } from "@earendil-works/pi-agent-core";
import type { StoreValue } from "@earendil-works/pi-agent-core/conformance";
import type { AssistantMessageEvent, StopReason, Usage } from "@earendil-works/pi-ai";
import { PROVIDER_CALL_ERROR_CODES, type ProviderCallErrorCode, type ProviderCallKind } from "./wire.ts";

/** `dispatched` -> `ended` -> `closed` (by the step commit, W9); `superseded` and `cancelled` are final. */
export type EgressCallState = "dispatched" | "ended" | "superseded" | "cancelled" | "closed";
/** `callback-stream` providers run tools inside the stream, so every reissue of their step needs a user choice. */
export type EgressCallCapability = "callback-stream" | "stream";

export type EgressCallResult =
	| {
			readonly kind: "message";
			readonly events: readonly AssistantMessageEvent[];
			readonly usage: Usage;
			readonly stopReason: StopReason;
	  }
	| {
			readonly kind: "error";
			readonly code: ProviderCallErrorCode;
			readonly message: string;
			readonly retryable: boolean;
			readonly usage?: Usage;
	  };

export interface EgressCallRow {
	readonly callId: string;
	readonly sessionId: string;
	readonly call: ProviderCallKind;
	readonly route: "sealed" | "device";
	readonly deviceId?: DeviceId;
	readonly providerId: ProviderId;
	readonly modelId: string;
	readonly epoch: number;
	readonly capability: EgressCallCapability;
	/** The stored request already carries this session's request hooks (4.5). */
	readonly hooksApplied: boolean;
	readonly state: EgressCallState;
	readonly requestChunks: number;
	readonly result?: EgressCallResult;
}

/** Durable `session/variants[P][deviceId]` (4.2); `mismatches` counts per (device, step) and restarts on a new head. */
export interface VariantRecord {
	readonly headDigest: string;
	readonly liveAtMismatch: string | undefined;
	readonly mismatches: number;
}

export const REQUEST_CHUNK_BYTES = 96 * 1024;

const enc = encodeURIComponent;
const pad = (index: number): string => String(index).padStart(6, "0");

export const callKey = (callId: string): string => `egress_call/${enc(callId)}`;
export const requestPrefix = (callId: string): string => `egress_call_request/${enc(callId)}/`;
export const requestChunkKey = (callId: string, index: number): string => `${requestPrefix(callId)}${pad(index)}`;
export const stepIndexPrefix = (stepId: string): string => `egress_step/${enc(stepId)}/`;
export const stepIndexKey = (stepId: string, attempt: number): string => `${stepIndexPrefix(stepId)}${pad(attempt)}`;
export const cancelledKey = (stepId: string): string => `session/step.cancelled/${enc(stepId)}`;
export const variantPrefix = (providerId: ProviderId): string => `session/variants/${enc(providerId)}/`;
export const variantKey = (providerId: ProviderId, deviceId: DeviceId): string =>
	`${variantPrefix(providerId)}${enc(deviceId)}`;

/** Splits UTF-8 text into chunks of at most `REQUEST_CHUNK_BYTES` bytes, never inside a code point. */
export function splitUtf8(text: string): string[] {
	const bytes = new TextEncoder().encode(text);
	const decoder = new TextDecoder();
	const chunks: string[] = [];
	for (let start = 0; start < bytes.length;) {
		let end = Math.min(start + REQUEST_CHUNK_BYTES, bytes.length);
		while (end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
		chunks.push(decoder.decode(bytes.subarray(start, end)));
		start = end;
	}
	return chunks.length > 0 ? chunks : [""];
}

type StoreObject = { readonly [key: string]: StoreValue };
const isObject = (value: StoreValue | undefined): value is StoreObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isErrorCode = (value: unknown): value is ProviderCallErrorCode =>
	PROVIDER_CALL_ERROR_CODES.some((code) => code === value);
const isState = (value: StoreValue | undefined): value is EgressCallState =>
	value === "dispatched" || value === "ended" || value === "superseded" || value === "cancelled" || value === "closed";

function decodeCall(value: StoreValue | undefined): ProviderCallKind | undefined {
	if (!isObject(value)) return undefined;
	if (value.kind === "step" && typeof value.stepId === "string" && typeof value.attempt === "number")
		return { kind: "step", stepId: value.stepId, attempt: value.attempt };
	const { auxId, streamKind, auxKind } = value;
	if (value.kind !== "aux" || typeof auxId !== "string" || typeof streamKind !== "string") return undefined;
	if (auxKind !== "stream" && auxKind !== "warm" && auxKind !== "compact-endpoint") return undefined;
	return { kind: "aux", auxId, streamKind, auxKind };
}

/** The ledger's own result JSON; the shape check guards against a truncated or foreign document. */
function isCallResult(value: unknown): value is EgressCallResult {
	if (typeof value !== "object" || value === null || !("kind" in value)) return false;
	if (value.kind === "message")
		return "events" in value && Array.isArray(value.events) && "stopReason" in value && "usage" in value;
	return value.kind === "error" && "code" in value && isErrorCode(value.code) && "message" in value;
}

export function encodeCallRow(row: EgressCallRow): StoreValue {
	const { deviceId, result, ...fields } = row;
	return {
		...fields,
		...(deviceId === undefined ? {} : { deviceId }),
		...(result === undefined ? {} : { result: JSON.stringify(result) }),
	};
}

export function decodeCallRow(value: StoreValue | undefined): EgressCallRow | undefined {
	if (!isObject(value)) return undefined;
	const { callId, sessionId, route, deviceId, providerId, modelId, epoch, capability, hooksApplied, state } = value;
	const { requestChunks, result } = value;
	const call = decodeCall(value.call);
	if (typeof callId !== "string" || typeof sessionId !== "string" || !call) return undefined;
	if ((route !== "sealed" && route !== "device") || typeof providerId !== "string" || typeof modelId !== "string")
		return undefined;
	if (typeof epoch !== "number" || typeof hooksApplied !== "boolean" || typeof requestChunks !== "number")
		return undefined;
	if ((capability !== "callback-stream" && capability !== "stream") || !isState(state)) return undefined;
	const parsed: unknown = typeof result === "string" ? JSON.parse(result) : undefined;
	if (result !== undefined && !isCallResult(parsed)) return undefined;
	return {
		callId,
		sessionId,
		call,
		route,
		providerId,
		modelId,
		epoch,
		capability,
		hooksApplied,
		state,
		requestChunks,
		...(typeof deviceId === "string" ? { deviceId } : {}),
		...(isCallResult(parsed) ? { result: parsed } : {}),
	};
}

export interface StoredVariant extends VariantRecord {
	readonly stepId: string;
}

export function decodeVariant(value: StoreValue | undefined): StoredVariant | undefined {
	if (!isObject(value)) return undefined;
	const { headDigest, liveAtMismatch, mismatches, stepId } = value;
	if (typeof headDigest !== "string" || typeof mismatches !== "number" || typeof stepId !== "string") return undefined;
	return {
		headDigest,
		liveAtMismatch: typeof liveAtMismatch === "string" ? liveAtMismatch : undefined,
		mismatches,
		stepId,
	};
}

export const encodeVariant = (variant: StoredVariant): StoreValue => ({
	headDigest: variant.headDigest,
	liveAtMismatch: variant.liveAtMismatch ?? null,
	mismatches: variant.mismatches,
	stepId: variant.stepId,
});
