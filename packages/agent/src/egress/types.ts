/**
 * `ModelEgress`: one provider-pipeline layer that decides, per provider and per request, whether a model call
 * is dialed directly (today's stream function, unchanged), with secrets released from sealed custody, or
 * through a device the user owns. Only types and constants live here; implementations live with the
 * provider pipeline, and the fused path passes today's stream function through untouched.
 */
import type { StreamFn } from "../types.ts";

export type ProviderId = string;
export type DeviceId = string;
export type Epoch = number;
export type EgressRoute = "direct" | "sealed" | "device";

export type RouteReason =
	| "fused"
	| "custody:sealed"
	| "custody:device"
	| "roster:unknown"
	| "custody:cwd-scoped"
	| "custody:unavailable"
	| "owner:revoked"
	| "definition:variant"
	| "address:private"
	| "address:self"
	| "address:unknown"
	| "capability:local-only"
	| "capability:ambient"
	| "capability:callback-stream"
	| "capability:callback-stream-undefined"
	| "api:no-fetch-injection"
	| "network:device-bound"
	| "provider:extension"
	| "provider:hand-local"
	| "provider:unknown"
	| "hook:stream"
	| "hook:stream-undefined"
	| "hook:unknown"
	| "hook:request-offline"
	| "redirect:cross-origin";

export type WaitCondition =
	| { readonly kind: "device-online"; readonly deviceId: DeviceId }
	| { readonly kind: "custody-available" }
	| { readonly kind: "refresh-ack"; readonly providerId: ProviderId }
	| { readonly kind: "roster-sync" }
	| { readonly kind: "hand-selected" }
	| { readonly kind: "hand-advertised"; readonly deviceId: DeviceId }
	| { readonly kind: "config-head-change" }
	| { readonly kind: "live-digest-change"; readonly deviceId: DeviceId; readonly providerId: ProviderId }
	| { readonly kind: "storage-available" }
	| { readonly kind: "epoch-fresh" }
	| { readonly kind: "claim-renewed" }
	| { readonly kind: "user-choice"; readonly choiceId: string };

export interface EgressRouteDecision {
	readonly route: EgressRoute;
	readonly reason: RouteReason;
	readonly deviceId?: DeviceId;
	/** False: the call waits in the stream (never fails) until `waitFor` holds, showing `steer`. */
	readonly servedNow: boolean;
	readonly steer?: string;
	readonly waitFor?: readonly WaitCondition[];
	readonly requestHooksOn?: DeviceId;
	readonly executorHooks?: "enabled" | "disabled";
	readonly serveOwnDefinition?: true;
}

/** The durable admission fence; `generation` is the agent instance generation, and older generations are refused for good. */
export interface AdmissionFence {
	readonly epoch: Epoch;
	readonly admissionSeq: number;
	readonly generation: number;
}

export interface StepRef {
	readonly kind: "step";
	readonly sessionId: string;
	readonly stepId: string;
	readonly attempt: number;
	readonly fence: AdmissionFence;
}

export interface AuxRef {
	readonly kind: "aux";
	readonly sessionId: string;
	readonly auxId: string;
	readonly auxKey: string;
	readonly streamKind: string;
	readonly fence: AdmissionFence;
}

export type CallRef = StepRef | AuxRef;

export interface EgressWait {
	readonly call: CallRef;
	readonly reason:
		| RouteReason
		| "device-offline"
		| "result-pending"
		| "refresh-pending"
		| "config-churn"
		| "epoch-stale"
		| "claim-expired";
	readonly steer: string;
	readonly waitFor: readonly WaitCondition[];
}

export interface EgressHostHooks {
	currentStep(): StepRef;
	admitAux(streamKind: string, auxKey: string): Promise<AuxRef>;
	onWait(wait: EgressWait): Promise<void>;
	onWaitEnd(callId: string): Promise<void>;
	historyHasStep(stepId: string): Promise<boolean>;
}

/** Bound from a hosted session latching on a failed step commit to its rebuilt instance accepting work. */
export const HOSTED_REBUILD_DEADLINE_MS = 5_000;
/** Maximum age of a registry epoch check accepted for a secret release, a step commit or a tool dispatch. */
export const EPOCH_FRESHNESS_MS = 5_000;
/** Margin a new placement owner waits beyond `EPOCH_FRESHNESS_MS` before cutting over a moved session. */
export const MOVE_SKEW_MS = 2_000;

export interface ModelEgress {
	/** Pure and cheap: no I/O, safe to call from UI code. */
	routeFor(providerId: ProviderId): EgressRouteDecision;
	readonly stream: StreamFn;
}
