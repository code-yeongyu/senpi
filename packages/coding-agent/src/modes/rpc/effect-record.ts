import { createHash } from "node:crypto";
import { z } from "zod";

/** Custom transcript entry for every non-input effect; inputs keep `rpc_client_message_admission`. */
export const RPC_EFFECT_ENTRY = "rpc_effect";
export const EFFECT_LEDGER_CAPABILITY = "effect_ledger";

const actorSchema = z.object({ connectionId: z.string() });
export type EffectActor = z.infer<typeof actorSchema>;

/**
 * How an effect ended. `completed` needs no words; every other kind carries `reason` (the code) and
 * `detail` (plain words), plus `action` whenever the caller can do something about it.
 */
export const effectOutcomeSchema = z.object({
	kind: z.enum([
		"completed",
		"aborted",
		"error",
		"deadline",
		"interrupted_by_reopen",
		"dropped_by_replace",
		"unknown_model",
		"provider_unavailable",
		"unsupported_thinking_level",
		"superseded",
		"context_budget",
		"cleared",
		// 2026.10.16-2 wrote an abort-drained input under this name; it must stay readable.
		"cleared_by_abort",
		"already_delivered",
		"not_found",
		"conflict",
		"refused",
	]),
	reason: z.string().optional(),
	detail: z.string().optional(),
	action: z.string().optional(),
	abortSource: z.string().optional(),
	abortedBy: actorSchema.optional(),
});
export type EffectOutcome = z.infer<typeof effectOutcomeSchema>;

export interface QueuedChangeAnswer {
	readonly text?: string;
	readonly revision?: number;
	readonly currentRevision?: number;
}

export type EffectKind = "input" | "abort" | "unload" | "set_model" | "set_thinking_level" | "dequeue" | "edit_queued";
export type EffectState = "accepted" | "applied" | "done" | "failed";

export const rpcEffectRecordSchema = z.object({
	effectId: z.string().min(1).max(256),
	kind: z.enum(["abort", "unload", "set_model", "set_thinking_level", "dequeue", "edit_queued"]),
	state: z.enum(["accepted", "applied", "done", "failed"]),
	disposition: z.string().optional(),
	outcome: effectOutcomeSchema.optional(),
	// What a queued-input change answered beyond its status, so a replay answers exactly as the live call did.
	answer: z
		.object({
			text: z.string().optional(),
			revision: z.number().int().positive().optional(),
			currentRevision: z.number().int().positive().optional(),
		})
		.optional(),
	by: actorSchema,
	acceptedAt: z.string(),
	updatedAt: z.string(),
	durableSessionId: z.string(),
	fingerprint: z.string(),
});
export type RpcEffectRecord = z.infer<typeof rpcEffectRecordSchema>;

/** The one answer `get_effect_status` and every effect command's response carry. */
export interface EffectStatus {
	readonly effectId: string;
	readonly kind: EffectKind;
	readonly state: EffectState;
	readonly disposition?: string;
	readonly outcome?: EffectOutcome;
	/** A queued-input change's answer fields (`text`/`revision` for edited, `currentRevision` for conflict). */
	readonly answer?: QueuedChangeAnswer;
	readonly by?: EffectActor;
	readonly acceptedAt?: string;
	readonly updatedAt?: string;
	/** The routing handle the effect is being answered on; absent when read from disk. */
	readonly sessionId?: string;
	readonly durableSessionId: string;
}

export function isTerminalEffectState(state: EffectState): boolean {
	return state === "done" || state === "failed";
}

export class EffectIdConflict extends Error {
	readonly code = "effect_id_conflict";
	readonly effectId: string;
	readonly reason = "effect_id_conflict: this effectId was already used for a different request";
	readonly action = "send the request again with a new effectId";

	constructor(effectId: string) {
		super(`effect_id_conflict: effectId ${effectId} was already used for a different request`);
		this.name = "EffectIdConflict";
		this.effectId = effectId;
	}
}

export type EffectCommandKind = "abort" | "set_model" | "set_thinking_level" | "unload" | "dequeue" | "edit_queued";

/**
 * The SEMANTIC fields of each command kind, listed explicitly. The request `id`, the `effectId`, the
 * routing `sessionId` (reallocated on every reopen) and every transport field are never hashed, so
 * the same effect retried under a new routing handle after a reopen still replays.
 */
const SEMANTIC_FIELDS: Readonly<Record<EffectCommandKind, readonly string[]>> = {
	abort: ["awaitIdle", "clearQueue", "graceMs"],
	set_model: ["provider", "modelId", "thinkingLevel"],
	set_thinking_level: ["level", "scope"],
	unload: ["interrupt", "clearQueue", "children", "force"],
	dequeue: ["queuedId", "expectedRevision"],
	edit_queued: ["queuedId", "text", "expectedRevision"],
};

export function effectFingerprint(command: EffectCommandKind, payload: object): string {
	const semantic: Record<string, unknown> = { kind: command };
	for (const field of SEMANTIC_FIELDS[command]) {
		const value: unknown = Reflect.get(payload, field);
		if (value !== undefined) semantic[field] = value;
	}
	return createHash("sha256").update(JSON.stringify(semantic)).digest("hex");
}
