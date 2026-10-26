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
	| "session_closing";
