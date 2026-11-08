/**
 * The brain-to-hand `model` lane of hosted model-key custody (row CK7; custody design 2.2, 4.3, 4.6, 15.14, 15.15).
 *
 * Message shapes only: the brain's device-proxy egress (CK9), the hand's provider-call executor (CK8), the hook and
 * refresh channels (CK16, CK21) and the publisher (CK12d) speak these. Every request that makes the hand execute
 * something carries a `SignedPlacementClaim`, checked by `verifyPlacementClaim` before anything runs.
 */
import type { DeviceId, ProviderId, WaitCondition } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessageEvent,
	SimpleStreamOptions,
	StopReason,
	TranscriptContext,
	Usage,
} from "@earendil-works/pi-ai";
import type { OpenAiCompactBody } from "../extensions/builtin/compaction/openai-remote-schema.ts";
import type { UrlSecretField } from "./endpoint.ts";
import type { SignedPlacementClaim } from "./placement-claim.ts";
import type { ServiceKeyEntry } from "./roster-entries.ts";

/**
 * The stream options a brain may send a hand: serializable request shaping only. Never secrets or headers, callbacks,
 * signals or live objects, host-local values (`env`, `cwd`; the start message carries the session cwd) or the
 * loop-only `commitStep` (4.3, 2.3 options hygiene).
 */
export const WIRE_STREAM_OPTION_KEYS = [
	"abortServerSideFallback",
	"affinitySessionId",
	"cacheRetention",
	"deferred",
	"extraBody",
	"maxRetries",
	"maxRetryDelayMs",
	"maxTokens",
	"metadata",
	"reasoning",
	"refusalFallbacks",
	"samplingParams",
	"serviceTier",
	"sessionAffinityKey",
	"sessionId",
	"streamKind",
	"temperature",
	"thinkingBudgets",
	"thinkingSelection",
	"timeoutMs",
	"toolChoice",
	"transport",
	"websocketConnectTimeoutMs",
] as const satisfies readonly (keyof SimpleStreamOptions)[];

export type WireStreamOptions = Pick<SimpleStreamOptions, (typeof WIRE_STREAM_OPTION_KEYS)[number]>;
export type HandLocalStreamOptionKey = Exclude<keyof SimpleStreamOptions, keyof WireStreamOptions>;

export const PROVIDER_CALL_ERROR_CODES = [
	"auth",
	"rate_limited",
	"unavailable",
	"aborted",
	"unknown_provider",
	"local_only_unsupported",
	"stale_epoch",
	"claim_expired",
	"claim_invalid",
	"registry_key_unknown",
	"registry_key_revoked",
	"definition_mismatch",
] as const;
export type ProviderCallErrorCode = (typeof PROVIDER_CALL_ERROR_CODES)[number];

export type SecretField =
	| "apiKey"
	| `credential:${number}`
	| `header:${string}`
	| `modelHeader:${string}:${string}`
	| UrlSecretField;

/** A JSON value, for payloads whose precise schema another row owns (see `HookModelRequestInput`, `WrapTable`). */
export type WireJson = string | number | boolean | null | readonly WireJson[] | { readonly [key: string]: WireJson };

/** The serializable projection of today's request-hook input; CK21 pins its golden shape. */
export type HookModelRequestInput = WireJson;
/** keyId -> recipientKeyId -> HPKE wrap, the wraps-document tables (2.2); CK3 owns the wrap encoding. */
export type WrapTable = Readonly<Record<string, Readonly<Record<string, WireJson>>>>;

export type ProviderCallKind =
	| { readonly kind: "step"; readonly stepId: string; readonly attempt: number }
	| {
			readonly kind: "aux";
			readonly auxId: string;
			readonly streamKind: string;
			readonly auxKind: "stream" | "warm" | "compact-endpoint";
	  };

/** Step, aux `stream` and aux `warm` carry the admitted request; `compact-endpoint` carries only the body (15.14). */
export type ProviderCallRequest =
	| { readonly context: TranscriptContext; readonly options: WireStreamOptions }
	| { readonly compactBody: OpenAiCompactBody };

export interface ProviderCallStart {
	readonly t: "provider.call.start";
	readonly callId: string;
	readonly sessionId: string;
	readonly call: ProviderCallKind;
	readonly claim: SignedPlacementClaim;
	readonly providerId: ProviderId;
	readonly modelId: string;
	readonly expectedSourceDigest?: string;
	/** Always `"disabled"` for aux calls. */
	readonly hooks: "enabled" | "disabled";
	readonly cwd?: string;
	readonly request: ProviderCallRequest;
	readonly budget: { readonly deadlineMs: number; readonly maxOutputTokens?: number };
}

/** Sent once, before the dial, when the hand ran the session's request hooks; seq 0 is reserved for it. */
export interface ProviderCallHooked {
	readonly t: "provider.call.hooked";
	readonly callId: string;
	readonly seq: 0;
	readonly request: ProviderCallRequest;
}

export interface ProviderCallEvent {
	readonly t: "provider.call.event";
	readonly callId: string;
	readonly seq: number;
	readonly event: AssistantMessageEvent;
}

export interface ProviderCallEnd {
	readonly t: "provider.call.end";
	readonly callId: string;
	readonly seq: number;
	readonly usage: Usage;
	readonly stopReason: StopReason;
}

export interface ProviderCallError {
	readonly t: "provider.call.error";
	readonly callId: string;
	readonly seq: number;
	readonly code: ProviderCallErrorCode;
	readonly until?: number;
	readonly retryable: boolean;
	readonly usage?: Usage;
	readonly message: string;
}

export interface ProviderCallCancel {
	readonly t: "provider.call.cancel";
	readonly callId: string;
	readonly reason: "user" | "superseded" | "budget" | "shutdown";
}

export interface ProviderCallAck {
	readonly t: "provider.call.ack";
	readonly callId: string;
}

export interface ProviderCallResultQuery {
	readonly t: "provider.call.result";
	readonly callId: string;
	readonly claim: SignedPlacementClaim;
}

export type ProviderCallResultReply =
	| { readonly t: "provider.call.result.reply"; readonly callId: string; readonly state: "unknown" }
	| {
			readonly t: "provider.call.result.reply";
			readonly callId: string;
			readonly state: "running";
			readonly lastSeq: number;
			readonly hooked?: ProviderCallHooked;
	  }
	| {
			readonly t: "provider.call.result.reply";
			readonly callId: string;
			readonly state: "done";
			readonly hooked?: ProviderCallHooked;
			readonly events: readonly AssistantMessageEvent[];
			readonly end: ProviderCallEnd | ProviderCallError;
	  };

export interface CustodyRefreshRequest {
	readonly t: "custody.refresh.request";
	readonly providerId: ProviderId;
	readonly field: SecretField;
	readonly version: number;
	readonly claim: SignedPlacementClaim;
}

export interface CustodyRefreshAck {
	readonly t: "custody.refresh.ack";
	readonly providerId: ProviderId;
	readonly field: SecretField;
	readonly outcome: "changed" | "unchanged" | "unresolved";
	readonly version?: number;
}

/** `recipient`: a device enrolled during a custody kill that needs K_cfg/K_proj wraps from a peer (6.6(d), 3.6). */
export interface CustodyRewrapRequest {
	readonly t: "custody.rewrap.request";
	readonly dekIds: readonly string[];
	readonly custodyEntry: ServiceKeyEntry;
	readonly recipient?: DeviceId;
}

/** Device to device over the hand channel; never sent to the service. */
export interface CustodyRewrapDeliver {
	readonly t: "custody.rewrap.deliver";
	readonly recipient: DeviceId;
	readonly cfgWraps: WrapTable;
	readonly projWraps: WrapTable;
	readonly projCheck: Readonly<Record<string, string>>;
	readonly sig: string;
}

export interface HookModelRequest {
	readonly t: "hook.model_request";
	readonly sessionId: string;
	readonly stepId: string;
	readonly claim: SignedPlacementClaim;
	readonly input: HookModelRequestInput;
}

export interface HookModelRequestReply {
	readonly t: "hook.model_request.reply";
	readonly sessionId: string;
	readonly stepId: string;
	readonly output: HookModelRequestInput;
}

export interface HandSessionAdvertisement {
	readonly t: "hand.session.advertise";
	readonly sessionId: string;
	readonly connectionId: string;
	readonly cwd: string;
	/** H(extension set hash, cwd, project-local hook set), per session (4.9). */
	readonly advertHash: string;
	readonly requestHooks: readonly ProviderId[] | "*";
	readonly streamHooks: readonly ProviderId[] | "*";
	readonly extensionProviders: readonly ProviderId[];
	readonly handLocalProviders: readonly { readonly id: ProviderId; readonly models: readonly string[] }[];
	readonly handDefines: readonly ProviderId[];
}

export interface HandPresence {
	readonly deviceId: DeviceId;
	readonly online: boolean;
	readonly capabilities: readonly string[];
	/** sessionId -> advertHash for the sessions bound to this hand. */
	readonly sessionAdverts?: Readonly<Record<string, string>>;
	/** providerId -> this device's current live sourceDigest for the providers it defines; re-sent on file change. */
	readonly liveDigests?: Readonly<Record<ProviderId, string>>;
}

export type StepNotice =
	| {
			readonly t: "step.waiting";
			readonly sessionId: string;
			readonly stepId: string;
			readonly steer: string;
			readonly waitFor: readonly WaitCondition[];
	  }
	| { readonly t: "step.resumed"; readonly sessionId: string; readonly stepId: string }
	| {
			readonly t: "step.reset";
			readonly sessionId: string;
			readonly stepId: string;
			readonly cause: "superseded" | "readmitted";
	  };

export interface ProviderCallChannel {
	start(msg: ProviderCallStart): Promise<void>;
	result(msg: ProviderCallResultQuery): Promise<ProviderCallResultReply>;
	ack(msg: ProviderCallAck): Promise<void>;
	cancel(msg: ProviderCallCancel): Promise<void>;
	/** Resumes from any seq; `fromSeq: 0` includes `hooked`. */
	events(
		callId: string,
		fromSeq: number,
	): AsyncIterable<ProviderCallHooked | ProviderCallEvent | ProviderCallEnd | ProviderCallError>;
	readonly presence: AsyncIterable<HandPresence>;
	readonly hooks: AsyncIterable<HandSessionAdvertisement>;
}
