import type { EffectState, EffectStatus } from "./effect-record.ts";

/** `abort` with `awaitIdle` or `clearQueue`: whether the turn stopped and what was cleared. */
export interface RpcAbortQuiesce {
	/** The aborted turn ended within `graceMs` (with `clearQueue` alone: no turn was running). */
	stopped: boolean;
	/** The session was idle when the answer was sent. Equal to `stopped` today; kept separate so a later
	 * host can report a stopped turn whose session immediately started queued work. */
	idle: boolean;
	/** Queued inputs `clearQueue` removed (0 when not requested). */
	cleared: number;
}

/** What `dequeue_message` / `edit_queued_message` did; anything but removed/edited carries reason + action. */
export interface RpcQueuedInputChange {
	queuedId: string;
	status: "removed" | "edited" | "already_delivered" | "not_found" | "conflict";
	/** `edited`: the text and revision the input now has. */
	text?: string;
	revision?: number;
	/** `conflict`: the input's revision, which `expectedRevision` did not match; nothing was changed. */
	currentRevision?: number;
	reason?: string;
	action?: string;
}

/** What an effect command (`abort`/`set_model`/`set_thinking_level` with `effectId`) answers about its receipt. */
export interface RpcEffectAnswer {
	effectId: string;
	state: EffectState;
	effect: EffectStatus;
	/** The id was seen before with the same request: nothing was performed again. */
	replayed?: true;
}

/** What `unload_session` answers. `effect` is the ledger receipt when the command carried an `effectId`. */
export interface RpcUnloadAnswer {
	outcome: "unloaded" | "refused";
	sessionPath?: string;
	reason?: UnloadRefusalReason;
	detail?: string;
	action?: string;
	/**
	 * Deliveries an `interrupt` handed back unwritten: their sender redelivers them. Absent when there were none. A
	 * graceful close always names them, with the user's queued text (`user_messages`, in enqueue order).
	 */
	dropped?: { deliveries: readonly string[]; user_messages?: readonly string[] };
	/**
	 * An RPC host's `unloaded` answer: the child sessions open on this host that the unload left running (`children:
	 * "detach"`), read in the step that claimed the close; `[]` when there were none or `children` was not `detach`.
	 */
	detached?: readonly string[];
	/** A graceful close that ended the session: the turn it waited for and the work sources it stopped. */
	graceful?: { turn: number; waited_ms: number; stopped: { wake_sources: readonly string[] } };
	/** A graceful close whose drain outlived `waitMs`: the session is still open (`open`) and admitting again. */
	timed_out?: true;
	open?: true;
	admission?: "reopened";
	/** The turn a timed-out graceful close waited for, and how long it waited. */
	turn?: number;
	waited_ms?: number;
	/** A `work_pending` refusal's admitted deliveries not yet written: what a forced unload would hand back. */
	pending?: { deliveries: readonly string[] };
	effectId?: string;
	effect?: EffectStatus;
	replayed?: boolean;
}

export type UnloadRefusalReason =
	| "turn_active"
	| "work_pending"
	| "extension_work"
	| "children_live"
	| "attached"
	| "host_draining"
	| "unsupported"
	| "session_closing"
	/** A terminal's control endpoint: its composer holds unsent text a graceful close would discard. */
	| "composer_draft";
