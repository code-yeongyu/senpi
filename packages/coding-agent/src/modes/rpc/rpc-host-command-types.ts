import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import type { SessionRetryFallbackProfile } from "../../core/agent-session-runtime.ts";

import type { BrowserEngine } from "../../core/browser-engine.ts";

import type { PromptSurface } from "../../core/dynamic-prompt/types.ts";

import type { SessionKind } from "../../core/extensions/types.ts";

import type { RpcAttachmentCommand } from "./attachment-types.ts";
import type { RpcExtensionUIProgress, RpcExtensionUIResponse } from "./rpc-question-types.ts";
import type { RpcHostResponse } from "./rpc-relocation-types.ts";
import type { RpcSessionCommand } from "./rpc-session-command-types.ts";
import type { RpcMoveSessionCommand } from "./session-move-wire.ts";

/** Every established command accepts an additive routing envelope. */
export type RpcCommand =
	| RpcAttachmentCommand
	| (RpcSessionCommand & { sessionId?: string })
	| {
			id?: string;
			type: "get_protocol_info";
			/** Public POSIX endpoint challenge (wire contract v1.1); ignored by hosts that predate authentication. */
			auth?: { readonly client_nonce: string };
			/** An observing read: this connection never counts as host activity (docs/rpc.md, idle exit). */
			observe?: boolean;
	  }
	| {
			id?: string;
			type: "open_session";
			/** An observational/unattended open; attaching never releases an existing hold. */
			attended?: false;
			spawnedBy?: import("../../core/session-lifecycle-types.ts").SpawnedBy;
			/**
			 * Attach only to an existing session on this host generation. Requires
			 * `expected_host_instance`; mismatch returns `owner_changed`, a released
			 * session returns `session_not_held`. Neither refusal creates a writer.
			 */
			expectedHostInstance?: string;
			sessionPath?: string;
			cwd?: string;
			provider?: string;
			modelId?: string;
			thinkingLevel?: ThinkingLevel;
			permissionPreset?: string;
			/**
			 * Keep this session alive when its last client disconnects (default false).
			 * The drop only releases that client's attachment: the session stays listed
			 * with `attachments: 0`, finishes its turn, and is re-attached by a later
			 * `open_session` for the same `sessionPath`. Requires the host capability
			 * `retain_on_disconnect`; older hosts ignore the field and close as before.
			 */
			retain_on_disconnect?: boolean;
			/**
			 * Visibility class of this session (default `interactive`). A `worker` session is
			 * machine-driven work: it is omitted from `list_sessions` unless the caller asks
			 * for workers, and its lifecycle records reach only connections attached to it.
			 * Requires the host capability `session_kind`.
			 */
			kind?: SessionKind;
			/**
			 * Opaque labels for this session, readable by its own extensions as
			 * `pi.sessionContext` and republished on `list_sessions { include_workers: true }`.
			 * At most 32 keys matching `^[a-z][a-z0-9_]*$`, each value at most 16 KiB, at most
			 * 32 KiB of JSON in total; anything else is refused with `invalid_session_context`.
			 * The host never interprets them. Requires the host capability `session_context`.
			 */
			context?: Record<string, string>;
			/**
			 * Whether THIS session auto-generates a title from its first prompt (default:
			 * the host's `--auto-title-sessions` / appMode decision). Requires the host
			 * capability `auto_title_per_session`. A non-boolean is refused with
			 * `invalid_launch_profile`.
			 */
			auto_title?: boolean;
			/**
			 * The durable session id to CREATE this session with, so a caller that already has a
			 * stable record id for the conversation keeps ONE identity instead of maintaining a
			 * mapping. Requires the host capability `durable_session_id`.
			 *
			 * Deliberately NOT named `sessionId`: the routing envelope above carries that name on
			 * every established command, and this value is not a routing handle.
			 *
			 * Applied ONLY when this open creates the session. When `sessionPath` names an existing
			 * session file, that file's header id stays authoritative and this field is ignored -
			 * a resume never rewrites identity. Refused with `invalid_session_id` when malformed and
			 * with `session_id_in_use` when a live session already holds it.
			 */
			durableSessionId?: string;
			/**
			 * Where THIS session's replies render (default: the host's `SENPI_PROMPT_SURFACE`). `app` builds
			 * a prompt with no visible routing line that keeps tool and hook feedback with the agent;
			 * `terminal` is the classic prompt; `chat` (a chat bridge) is `app` with no handoff block, ledger
			 * lines, or todo handoff cues, and needs `prompt_surface_chat`. A later open that attaches with
			 * another value rebuilds the session's prompt; an attach without it keeps the current surface.
			 * Requires the host capability `prompt_surface`. Any other value is refused with `invalid_launch_profile`.
			 */
			promptSurface?: PromptSurface;
			/**
			 * Which browser THIS session's skills drive: `connected` (the user's own browser), `builtin` (the
			 * app's in-app browser) or `none`. Session-scoped, never process-wide: the session's tool
			 * subprocesses and eval kernel see `OMO_BROWSER_ENGINE=<value>`, other sessions on the host do
			 * not, and a session opened without it sees no such variable. A later open that attaches with
			 * another value moves the live session to it; an attach without it keeps the current engine.
			 * Requires the host capability `browser_engine`. Any other value is refused with `invalid_launch_profile`.
			 */
			browserEngine?: BrowserEngine;
			/**
			 * The fallback policy THIS session runs with (e.g. a task child's own chain): applied as an
			 * in-memory override of this session's `retry.modelFallback` / `retry.fallbackChains`, never written
			 * to a settings file and never seen by another session. Requires the host capability
			 * `retry_fallback_profile`; a malformed value is refused with `invalid_launch_profile`. Applied
			 * when the open creates the session; an attach keeps the session's existing policy.
			 */
			retryFallback?: SessionRetryFallbackProfile;
			/**
			 * Environment variables for THIS session's tool subprocesses only (senpi#4381): applied to that
			 * one session after the daemon's own allowlist, never merged into the host process or carried to
			 * a successor generation, never seen by another session. Names must be on the host's
			 * caller-passable set (`OMOCAT_LANE` by default, plus `SENPI_RPC_CALLER_ENV_NAMES`); anything
			 * else is refused with `invalid_session_env`. A task child (`spawnedBy`) inherits its parent's
			 * entries unless it names them here. Applied when the open creates the session; an attach keeps
			 * the session's existing env. Requires the host capability `session_env`.
			 */
			env?: Record<string, string>;
	  }
	| { id?: string; type: "close_session"; sessionId: string }
	| RpcMoveSessionCommand
	| {
			id?: string;
			/**
			 * Hands the session over to a runtime outside this host (`omo daemon adopt` resumes it in a local
			 * terminal with `--session <session_path>`): records `session_released` in the transcript, tears
			 * the session down without replaying anything, and frees its path reservation, so the next
			 * writer of the file is the one the caller starts. Refused with `turn_active` mid-turn unless
			 * `interrupt` (the turn is aborted first), and with `attached` while clients hold it unless
			 * `force` (they receive `session_closed { reason: "released" }`).
			 */
			type: "release_session";
			sessionId: string;
			/** `move` seals the file for a move to another device (`moveId` required); writes are refused here after. */
			reason: "takeover" | "move";
			moveId?: string;
			target?: string;
			interrupt?: boolean;
			force?: boolean;
	  }
	| {
			id?: string;
			/**
			 * Free a session this host keeps loaded: the transcript stays, queued input is kept for the reopen,
			 * and `session_parked { reason: "unloaded" }` reaches every attached client. Refused with a reason
			 * and an action while work runs (unless `interrupt`), while other clients are attached (unless
			 * `force`) or while child sessions it started are open here (unless `children: "detach"`).
			 */
			type: "unload_session";
			sessionId: string;
			effectId?: string;
			interrupt?: boolean;
			clearQueue?: boolean;
			children?: "refuse" | "detach";
			force?: boolean;
	  }
	| {
			id?: string;
			/**
			 * Meant as the connection's last request: release every session attachment it holds, then answer.
			 * Advertised as `detach_connection`. Closing the socket afterwards releases nothing more.
			 */
			type: "detach_connection";
	  }
	| {
			id?: string;
			/** Every subscription account's latest limit windows (senpi#3370); capability `subscription_limits`. */
			type: "get_subscription_limits";
			/** An observing read, as on `get_protocol_info`. */
			observe?: boolean;
	  }
	| {
			id?: string;
			type: "list_sessions";
			/**
			 * Include `kind: "worker"` rows, each with its `context` (default false). A
			 * default listing publishes interactive sessions only and carries no `context`.
			 */
			include_workers?: boolean;
			/** An observing read, as on `get_protocol_info`. */
			observe?: boolean;
	  }
	| {
			id?: string;
			/**
			 * Subscribe this connection to `session_status` records (docs/rpc.md, "Session status stream"). The
			 * answer carries a snapshot at `seq: 0`; every later record of the subscription is strictly +1.
			 * Activity-neutral: never an attachment, never refreshes a session's idle window. Requires the host
			 * capability `session_status`.
			 */
			type: "subscribe_sessions";
			/** `"all"` (default), routing/durable ids or paths, or the children of one durable session id. */
			sessions?: "all" | { ids: string[] } | { childrenOf: string };
			/** Include `kind: "worker"` sessions (default: true for `childrenOf`, false otherwise). */
			include_workers?: boolean;
			/** Carry each session's published `context` on its records (default false). */
			include_context?: boolean;
			/**
			 * Also deliver `effect_status` receipts of matched sessions, each emitted after the record that
			 * caused the transition (default: true for `childrenOf`, false otherwise).
			 */
			effects?: boolean;
			/** Observe dialog registration and settlement without receiving command replies. */
			dialogs?: boolean;
			/** Also deliver these content record types of matched sessions (default `"none"`); opt-in, never an attachment. */
			mirror?: "none" | "all" | string[];
			/** Mark the request activity-neutral for the supervisor's idle exit, as on `list_sessions`. */
			observe?: boolean;
	  }
	| { id?: string; type: "unsubscribe_sessions"; subscriptionId: string; observe?: boolean }
	| {
			id?: string;
			/**
			 * Patch the context an attached session publishes (`list_sessions { include_workers: true }`, and
			 * `session_status` for subscribers with `include_context`). `null` deletes a key; host keys are
			 * refused with `invalid_session_context`. Requires the host capability `session_status`.
			 */
			type: "set_session_context";
			sessionId: string;
			patch: Record<string, string | number | boolean | null>;
	  }
	| {
			id?: string;
			type: "warm";
			/**
			 * Load what the next `open_session` with these inputs needs - the extension module graph and
			 * the runtimes its extensions load for this kind and context - WITHOUT opening a session
			 * (senpi#2314). Never listed, never an attachment, idempotent per profile. `cwd`, `kind` and
			 * `context` mean what they mean on `open_session`. Requires the host capability `warm`.
			 */
			cwd?: string;
			kind?: SessionKind;
			context?: Record<string, string>;
	  };

/** Stdin records: session/host commands plus extension-UI replies and progress, and host-request answers. */
export type RpcInboundRecord = RpcCommand | RpcExtensionUIResponse | RpcExtensionUIProgress | RpcHostResponse;
