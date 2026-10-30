import type { BrowserEngine } from "../../core/browser-engine.ts";
import type { McpFormInput, McpFormOutcome } from "../../core/mcp-form-types.ts";
import type { RecoveryCarrier } from "../../core/session-recovery-identity.ts";
import type { TranscriptTransition } from "../../core/session-transcript-journal.ts";
import type { PromptSurface } from "../../core/dynamic-prompt/types.ts";
import type { MirroredLimits } from "../../core/subscription-limits/limit-store.ts";
import type { CliRuntimeConfiguration } from "../../main.ts";
import type { ExtensionOwnerIdentity, ExtensionOwnerWire } from "./extension-owner.ts";
import type { RpcSessionState } from "./rpc-types.ts";
import type { SessionBootstrap } from "./session-acceptance-lane.ts";
import type { RpcSessionLaunchProfile } from "./session-registry.ts";
import { RpcSessionRegistryError } from "./session-registry-types.ts";

export const SESSION_WORKER_LIMITS = {
	workers: 20,
	requests: 64,
	controlRequests: 4,
	controlBytes: 1024 * 1024,
	requestBytes: 16 * 1024 * 1024,
	outputBytes: 16 * 1024 * 1024,
	reservations: 64,
	openMs: 30_000,
	controlMs: 5_000,
} as const;

/** A transition over the frame limit leaves its epoch's transcript unavailable; S12 transfers it in fragments. */
export function withinFrameLimit(transitions: readonly TranscriptTransition[]): TranscriptTransition[] {
	// Reserve fixed metadata space; content is charged in the same raw UTF-8 bytes as the accepted tail.
	const entryOverhead = 1024;
	return transitions.map((transition) =>
		(transition.kind === "append" ? Buffer.byteLength(transition.entry ?? "") : 0) + entryOverhead >
		SESSION_WORKER_LIMITS.outputBytes
			? { kind: "unavailable", reason: "transition_over_worker_frame_limit" }
			: transition,
	);
}

/** Wire values the host writes into a worker's wait signal; `conflict` is the generic denial. */
export const WORKER_CREDIT_CODES = { granted: 1, conflict: 2, limit: 3 } as const;

/** Host decision on a worker's session-write path request. */
export type SessionWriteGrant = keyof typeof WORKER_CREDIT_CODES;

export interface WorkerSnapshot {
	state: RpcSessionState;
	/** Canonicalized by the owning worker, never by the transport thread. */
	sessionPath?: string;
	/** Every canonical path this worker's live session writers still own. */
	liveSessionPaths: readonly string[];
	busy: boolean;
	/** Turn/request activity, excluding durable wake-source holds. */
	handoffBusy?: boolean;
	streaming: boolean;
}

export type HostToSessionWorker =
	| {
			type: "prepare";
			request: number;
			configuration: CliRuntimeConfiguration;
			profile: RpcSessionLaunchProfile;
			/** The host's subscription limit records when the isolate starts (senpi#3695). */
			subscriptionLimits: readonly MirroredLimits[];
	  }
	/** `acceptance`: the host owns an acceptance lane, so the isolate sends a bootstrap and ordered output frames. */
	| { type: "commit"; request: number; acceptance?: true; recoveryEpoch?: string }
	| {
			type: "bind";
			request: number;
			sessionId: string;
			capabilities: readonly string[];
			connection?: string;
			/** Roles the connection explicitly declared on the host (senpi#3811); the isolate adopts them. */
			roles?: readonly string[];
			mcpFormsEnforced?: boolean;
	  }
	| { type: "mcp_form_bound"; id: string; epoch: string; version?: string }
	| { type: "mcp_form_availability"; epoch: string; version?: string; id?: string }
	| { type: "mcp_form_settlement"; id: string; epoch: string; settlementId: string; outcome: McpFormOutcome }
	| {
			type: "command";
			request: number;
			command: object;
			connection?: string;
			roles?: readonly string[];
			/** The gate the host captured at ingress, before its first await (#4728). */
			owner?: ExtensionOwnerWire;
	  }
	/** Gates the host already retired atomically; the isolate only wakes their waiters. */
	| { type: "owners_retired"; owners: readonly ExtensionOwnerIdentity[] }
	| { type: "prompt_surface"; request: number; surface: PromptSurface }
	| { type: "browser_engine"; request: number; engine: BrowserEngine }
	| { type: "permission_preset"; request: number; preset: string }
	| { type: "cancel_ui" }
	| { type: "cancel_grant"; id: string }
	/** A change to the host's subscription limit records after `prepare`, mirrored into the isolate (senpi#3695). */
	| { type: "subscription_limits"; accounts: readonly MirroredLimits[] }
	| { type: "close" };

export type SessionWorkerToHost =
	| { type: "mcp_form_bind"; id: string; durableId: string }
	| { type: "mcp_form_ready"; id: string; epoch: string }
	| { type: "mcp_form_release"; epoch: string }
	| { type: "mcp_form_cancel"; id: string; epoch: string; lifetime: "operation" | "presentation" }
	| {
			type: "mcp_form_create";
			id: string;
			epoch: string;
			version: string;
			operationFence: SharedArrayBuffer;
			input: Omit<McpFormInput, "operationSignal" | "operationCurrent" | "presentationSignal">;
	  }
	| { type: "prepared"; request: number; sessionPath: string }
	| { type: "ready"; request: number; snapshot: WorkerSnapshot; bootstrap?: SessionBootstrap }
	| { type: "result"; request: number; error?: string }
	| { type: "reserve"; path: string; signal: SharedArrayBuffer }
	| { type: "snapshot"; snapshot: WorkerSnapshot; signal: SharedArrayBuffer; settled?: boolean }
	| { type: "control_done"; control: "cancel_ui" }
	| {
			type: "output";
			/** One per output frame of this worker incarnation, from 0; continuity only, never the accepted sequence. */
			ordinal?: number;
			record: object;
			recovery?: RecoveryCarrier;
			/** Transcript transitions the isolate's manager committed before this record, accepted just before it. */
			transitions?: readonly TranscriptTransition[];
			/** The next incarnation's baseline, on the `session_replaced` record that starts it. */
			bootstrap?: SessionBootstrap;
			connection?: string;
			/** The command's captured incarnation; targeted output never downgrades to the routing string. */
			owner?: ExtensionOwnerIdentity;
			signal: SharedArrayBuffer;
			activity: Pick<WorkerSnapshot, "busy" | "handoffBusy" | "streaming">;
			snapshot?: WorkerSnapshot;
	  }
	| { type: "capabilities"; connection?: string; capabilities: readonly string[]; signal: SharedArrayBuffer }
	| { type: "loaded_surfaces"; previous?: string; digest: string; signal: SharedArrayBuffer }
	| { type: "request_close" }
	/** A record a turn in the isolate reported, mirrored into the host's store (senpi#3695). */
	| { type: "subscription_limits"; limits: MirroredLimits }
	| { type: "failure"; error: string };

/**
 * A worker's refusal crosses the thread boundary as text. An `open_failed: <reason>` refusal is rebuilt as the typed
 * registry error, so a worker host answers `open_session` exactly as the in-process registry does (senpi#2898).
 */
export function typedWorkerRefusal(cause: unknown): never {
	const message = cause instanceof Error ? cause.message : String(cause);
	if (message.startsWith("open_failed: ")) throw new RpcSessionRegistryError("open_failed", message.slice(13));
	throw cause;
}

/**
 * Whether an open step failed only because its worker died: the worker's request channel rejects what is pending
 * with a plain `session_closing` / `session_worker_exited`, and the claims and grants it held report a typed
 * `session_closing` (senpi#4037).
 */
export function closedByWorkerDeath(cause: unknown): boolean {
	if (cause instanceof RpcSessionRegistryError) return cause.code === "session_closing";
	return cause instanceof Error && (cause.message === "session_closing" || cause.message === "session_worker_exited");
}
