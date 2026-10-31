import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, ThinkingSelection } from "@earendil-works/pi-ai";

import type { ServiceTier } from "../../core/extensions/builtin/service-tier.ts";
import type { SessionKind } from "../../core/extensions/types.ts";

import type { PendingInputUpdate } from "../../core/pending-input-session.ts";

export type RpcExtensionEvent = {
	type: "extension_event";
	name: string;
	data: unknown;
};

/** Emitted when the effective session thinking level changes. */
export interface RpcThinkingLevelChangedEvent {
	type: "thinking_level_changed";
	level: ThinkingLevel;
	/**
	 * Selector provenance in force after the change; absent when the level is an
	 * SDK-defaulted effective level rather than an explicit choice. Additive: an old
	 * client that does not know the field ignores it.
	 */
	thinkingSelection?: ThinkingSelection;
}

export interface RpcHighReasoningWarningEvent {
	type: "high_reasoning_warning";
	modelId: string;
	provider: string;
	thinkingLevel: ThinkingLevel;
}

/** A pending input in durable custody changed; `changes` are complete projections, in cursor order. */
export type RpcPendingInputUpdateEvent = { type: "pending_input_update" } & PendingInputUpdate;

/** Emitted after explicit skill tokens are expanded for a user-authored request. */
export interface RpcSkillInvocationEvent {
	type: "skill_invocation";
	skills: readonly {
		name: string;
		path: string;
		syntax: "dollar" | "slash";
	}[];
}

/** Emitted when startup or reload selects an existing settings file. */
export interface RpcSettingsSourceSelectedEvent {
	type: "settings_source_selected";
	path: string;
	format: "jsonc" | "json";
	reason: "explicit-jsonc" | "json-only";
	scope: "global" | "project";
}

/**
 * Emitted after the session's active model changed, with the thinking level in force AFTER
 * the switch (per-model memory, a favorite's pinned level, or the clamped previous level).
 *
 * Clients that tracked the model by inferring it from `entry_appended` can consume this
 * instead. Additive: an old client that does not know the type filters it out.
 */
export interface RpcModelChangedEvent {
	type: "model_changed";
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** Why the model changed: "set", "cycle", "restore", "fallback", or "fallback-revert". */
	source: string;
	/** Selector provenance for `thinkingLevel` after the switch, when one was explicit. */
	thinkingSelection?: ThinkingSelection;
}

/** Emitted when the effective service tier or fast-mode state of the session changes. */
export interface RpcServiceTierChangedEvent {
	type: "service_tier_changed";
	tier?: ServiceTier;
	fastMode: boolean;
}

/**
 * Emitted after the host swapped the live session behind this connection (new session,
 * fork, or switch), carrying the new authoritative identity.
 *
 * A replacement can be initiated by ANY attached client. Without this event the other
 * attached clients keep their stale identity and keep routing replacement-dependent
 * actions at the session that no longer exists. Additive: an old client that does not
 * know the type filters it out.
 */
export interface RpcSessionReplacedEvent {
	type: "session_replaced";
	/**
	 * Durable session id of the session now bound to this connection.
	 *
	 * Deliberately NOT `sessionId`: top-level `sessionId` is reserved for the
	 * per-connection routing handle that multi-session hosts tag every record
	 * with, and that tag is applied last - it would overwrite this value and
	 * leave the event carrying no identity at all.
	 */
	durableSessionId: string;
	/** Session file backing the new session, absent for a deferred setup-only session. */
	sessionFile?: string;
	cwd: string;
	sessionName?: string;
}

/**
 * Emitted when a shared host PARKS a session instead of closing it: the idle window
 * elapsed for a session opened with `retain_on_disconnect`, so the host released the
 * routing handle while the session itself stays on disk.
 *
 * It replaces `session_closed` for that handle - a parked session was not ended, and
 * `open_session { sessionPath }` reopens it (as a NEW routing handle). Additive: a
 * client that does not know the type filters it out and learns the handle is gone
 * from its next command's `unknown_session`.
 */
export type RpcSessionParkedEvent = {
	type: "session_parked";
	/** Routing handle that was released; it never resolves again. */
	sessionId: string;
	/** Session file to reopen this session by. */
	sessionPath: string;
	/** `idle`: the idle sweep parked it; `unloaded`: `unload_session` did. Absent from older hosts. */
	reason?: "idle" | "unloaded";
};

/**
 * Why a `session_closed` record was emitted, when the host names a reason.
 *
 * Optional on the wire and open to new members: a client that does not recognise a reason, or
 * receives a record with no `reason` field, treats it exactly as it treated a reason-less one.
 * Never required in decoders.
 *
 * - `client_close`: an attached client sent `close_session`.
 * - `idle_evicted`: the idle sweep ended a session that was not retained.
 * - `host_shutdown`: the host process is exiting (SIGTERM / idle-exit / empty-host).
 * - `replaced`: the live session behind this handle was swapped (`session_replaced` is the
 *   in-place identity event; this reason is for a handle that ended because of a replacement).
 * - `handoff_parked`: a generation handoff drained this host and put the session back on disk.
 *   The session was not ended - `open_session { sessionPath }` reopens it in the new generation.
 * - `session_dir_removed`: the session's transcript directory was deleted, so it could never persist
 *   again. The idle sweep ends it once no client holds it; a handoff drain ends it instead of parking
 *   it with a path nothing can reopen (senpi#2285).
 * - `error`: the session failed (worker death, output overflow) and the host sealed it.
 * - `released`: `release_session` handed the session to a runtime outside this host. `sessionPath` is
 *   the file that runtime now writes: do NOT reopen it on this host, which would make a second writer.
 */
export type RpcSessionClosedReason =
	| "client_close"
	| "idle_evicted"
	| "host_shutdown"
	| "replaced"
	| "handoff_parked"
	| "session_dir_removed"
	| "released"
	| "error";

/** Terminal record of a closed routing handle. `reason` is absent on older hosts and older records. */
export type RpcSessionClosedEvent = {
	type: "session_closed";
	sessionId: string;
	reason?: RpcSessionClosedReason;
	/** File released by handoff parking; reopen it on the successor. */
	sessionPath?: string;
};

/**
 * First lifecycle record of a session this host created. Interactive sessions broadcast it; a worker's
 * reaches its attached connections and `subscribe_sessions` subscribers with `include_workers`.
 * `context` is present only for subscribers that asked for it (`include_context`).
 */
export interface RpcSessionOpenedEvent {
	type: "session_opened";
	sessionId: string;
	durableSessionId?: string;
	sessionPath?: string;
	kind: SessionKind;
	cwd: string;
	context?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * Emitted after the loaded skill, extension, or MCP inventory changes. A multi-session host sends ONE per
 * connection per inventory digest, tagged with the first session that reported it.
 */
export interface RpcLoadedSurfacesChangedEvent {
	type: "loaded_surfaces_changed";
}

/** Emitted after an account is added, removed, pinned, or blocked by refresh failure. */
export interface RpcAuthAccountsChangedEvent {
	type: "auth_accounts_changed";
	provider: string;
}

/**
 * Sent to ONE opener the moment its `open_session` is accepted, before the open enters the
 * session loop. The in-process host serves opens one at a time, so a burst queues; without this
 * the client's only signal is a deadline it cannot explain (senpi#1844). A multi-session host sends
 * the same record for a session-routed `prompt` the moment it is received, before its preflight runs
 * on the session's loop, so a client waits out a slow preflight instead of discarding the session at
 * its plain request deadline (senpi#2871).
 *
 * `for_request` carries the opener's request id deliberately, NOT the response-id field: a client
 * settles pending requests by response id, and a queued record wearing the open's id would be
 * taken as the open's reply.
 */
export interface RpcOpenQueuedEvent {
	type: "queued";
	/** The `open_session` or `prompt` request this position belongs to. */
	for_request: string;
	/** 1-based place in the open queue at acceptance; for a `prompt`, its place among that session's requests in flight. */
	position: number;
	/** Opens (for a `prompt`, that session's requests) already in flight when this one arrived; `position` is this plus one. */
	in_flight: number;
}

/** Emitted when the SDK failover engine advances to a different account slot. */
export interface RpcAccountFailoverEvent {
	type: "account_failover";
	provider: string;
	from: string;
	to: string;
	reason: string;
}
