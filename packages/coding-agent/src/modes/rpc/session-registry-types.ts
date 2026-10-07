/** The shapes the in-process session registry hands out: entries, launch profiles, rows and its typed error. */
import type { ProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import type { AgentSessionLaunchProfile, AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type { HostMcpRegistry } from "../../core/extensions/builtin/mcp/host-registry.ts";
import type { SessionContext, SessionKind } from "../../core/extensions/types.ts";
import { EMPTY_SESSION_CONTEXT } from "../../core/extensions/types.ts";
import type { SessionPathReservations } from "./host-reservations.ts";
import type { PreparableRuntimeFactory } from "./host-warm.ts";
import type { SessionWorkerClient } from "./session-worker-client.ts";

/** The immutable flags selected when a routing session is opened. */
export interface RpcSessionLaunchProfile extends AgentSessionLaunchProfile {
	sessionPath?: string;
	/**
	 * Durable session id chosen by the caller, applied ONLY when this open creates the session.
	 * An existing session file keeps the id in its header, so a resume never rewrites identity.
	 */
	durableSessionId?: string;
}

export type SessionRuntime = AgentSessionRuntime;
export type RpcSessionState = "opening" | "open" | "closing" | "quarantined" | "closed";

export interface RpcSessionEntry {
	state: RpcSessionState;
	runtime?: SessionRuntime;
	worker?: SessionWorkerClient;
	/** Visibility class chosen by the open, frozen for the entry's life. */
	readonly kind: SessionKind;
	/** Frozen opaque labels the open attached; `{}` when it attached none. */
	readonly context: SessionContext;
	/** Resolves replacement against the runtime currently owned by this entry. */
	switchSession?: SessionRuntime["switchSession"];
	/** Rebind callback installed by the shared RPC connection handler. */
	rebindSession?: Parameters<SessionRuntime["setRebindSession"]>[0];
	scope: ProviderScope;
	profile: Readonly<RpcSessionLaunchProfile>;
	durableSessionId?: string;
	sessionPath?: string;
	/** Canonical reservation key for path-opened sessions; matches the reservations set. */
	reservationKey?: string;
	/** Key granted for the spelling this session was opened with; cleared once superseded. */
	requestedPathKey?: string;
	/** Current runtime cwd, which can change when a session is replaced. */
	cwd: string;
	/** Live attachments (open + later attaches). The runtime is disposed only when the last one closes. */
	attachments: number;
	/**
	 * Opt-in retention: a dropped connection only DETACHES from this session. The
	 * entry stays open at zero attachments (still listed, still running its turn,
	 * still holding its path) until an explicit close_session or idle eviction.
	 * Requested per `open_session`; an attach may turn it on, never off.
	 */
	retainOnDisconnect?: boolean;
	/** Timestamp of the last routed command / observed activity; drives idle eviction. */
	lastCommandAt: number;
	/**
	 * When the last attachment left (a retained session now standing detached), on the registry's
	 * clock; `undefined` while anyone is attached. A detached observational read does not refresh
	 * `lastCommandAt`, and the early-retirement sweep honors a minimum detach age so a transient
	 * reconnect keeps its runtime instead of re-opening cold.
	 */
	detachedAt?: number;
	lifecycleMutex: Promise<void>;
	closeCompletion?: Promise<void>;
	closeResolve?: () => void;
	closeStarted?: boolean;
}

export class RpcSessionRegistryError extends Error {
	readonly code:
		| "unknown_session"
		| "session_closing"
		| "session_path_in_use"
		| "session_id_in_use"
		| "session_reservation_limit"
		| "invalid_path"
		| "invalid_session_id"
		| "open_failed";
	/** Machine-readable context for the wire (`errorData`): who holds a path, when to retry. */
	readonly detail?: Readonly<Record<string, unknown>>;

	constructor(code: RpcSessionRegistryError["code"], reason?: string, detail?: Readonly<Record<string, unknown>>) {
		super(code === "open_failed" && reason ? `${code}: ${reason}` : code);
		this.code = code;
		this.name = "RpcSessionRegistryError";
		if (detail) this.detail = detail;
	}
}

export interface RpcSessionRegistryOptions {
	agentDir: string;
	/** A factory with `prepare` also gives the registry `warm` (senpi#2314). */
	createRuntime: PreparableRuntimeFactory;
	mcpRegistry?: HostMcpRegistry;
	/** Injectable clock (defaults to Date.now) so idle bookkeeping is testable. */
	now?: () => number;
	/** Maximum time to wait for graceful runtime teardown before forced release. */
	closeGraceMs?: number;
	/**
	 * Cross-GENERATION path claims. During a handoff two hosts are alive at once, and only a
	 * claim outside either process can keep them off one JSONL. Absent for an embedded registry
	 * that is the only host of its agent directory.
	 */
	pathReservations?: SessionPathReservations;
	/** Called after every entry is added or removed, with the new count (the zero-session trim's signal). */
	onSizeChange?: (size: number) => void;
}

/** Host-side lifecycle policy for one `open_session`, distinct from the session's launch profile. */
export interface RpcSessionOpenOptions {
	/** Keep the session alive when its last client disconnects (`open_session.retain_on_disconnect`). */
	retainOnDisconnect?: boolean;
}

/** One `list_sessions` row. `context` is published only to a listing that asked for workers. */
export interface RpcSessionRow {
	sessionId: string;
	durableSessionId?: string;
	sessionPath?: string;
	cwd: string;
	name?: string;
	status: Exclude<RpcSessionState, "quarantined">;
	attachments: number;
	kind: SessionKind;
	context: SessionContext;
}

export interface OpenRpcSession {
	sessionId: string;
	durableSessionId: string;
	sessionPath?: string;
	/** True when this open attached to an already-open session instead of creating one. */
	attached?: boolean;
}

/** Freezes an open's launch inputs, including the nested objects a client supplied. */
export function frozenProfile(profile: RpcSessionLaunchProfile): Readonly<RpcSessionLaunchProfile> {
	return Object.freeze({
		...profile,
		...(profile.creationModel ? { creationModel: Object.freeze({ ...profile.creationModel }) } : {}),
		...(profile.sessionContext ? { sessionContext: Object.freeze({ ...profile.sessionContext }) } : {}),
		...(profile.retryFallback
			? {
					retryFallback: Object.freeze({
						modelFallback: profile.retryFallback.modelFallback,
						fallbackChains: Object.freeze(
							Object.fromEntries(
								Object.entries(profile.retryFallback.fallbackChains).map(([key, entries]) => [
									key,
									Object.freeze([...entries]),
								]),
							),
						),
					}),
				}
			: {}),
	});
}

/**
 * The visibility class and labels an entry keeps for its life, normalized once here so no
 * lifecycle, listing or delivery decision has to re-apply the defaults. Reads the already
 * frozen profile, so the entry and the runtime share one frozen context object.
 */
export function sessionIdentity(profile: Readonly<RpcSessionLaunchProfile>): {
	readonly kind: SessionKind;
	readonly context: SessionContext;
} {
	return { kind: profile.sessionKind ?? "interactive", context: profile.sessionContext ?? EMPTY_SESSION_CONTEXT };
}
