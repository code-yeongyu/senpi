import type { AgentSession } from "../../core/agent-session.ts";
import { ModelUsabilityBudgetError } from "../../core/extensions/builtin/compaction/model-usability-budget.ts";
import { ModelSwitchAuthError } from "../../core/model-switch-auth-error.ts";
import { ABORT_DEFAULT_GRACE_MS, ABORT_MAX_GRACE_MS, isAbortGraceInRange } from "./abort-grace.ts";
import { ClientAdmissions } from "./client-admissions.ts";
import { type EffectBegin, EffectLedger } from "./effect-ledger.ts";
import {
	contextBudgetOutcome,
	EFFECT_OUTCOMES,
	modelSwitchErrorOutcome,
	providerUnavailableOutcome,
	unknownModelOutcome,
	unsupportedThinkingLevelOutcome,
} from "./effect-outcome-copy.ts";
import { type EffectActor, type EffectCommandKind, EffectIdConflict, type EffectStatus } from "./effect-record.ts";
import { lookupEffectInTranscript, TranscriptUnreadable } from "./effect-transcript-lookup.ts";
import {
	RPC_ERROR_CONTEXT_BUDGET,
	RPC_ERROR_EFFECT_ID_CONFLICT,
	RPC_ERROR_INVALID_ARGUMENT,
	RPC_ERROR_MODEL_NOT_FOUND,
	RPC_ERROR_PROVIDER_UNAVAILABLE,
	RPC_ERROR_TRANSCRIPT_UNREADABLE,
	type RpcCommand,
	type RpcEffectAnswer,
	type RpcResponse,
} from "./rpc-types.ts";
import { unsupportedThinkingLevel } from "./session-control-actions-data.ts";

type Command<T extends RpcCommand["type"]> = Extract<RpcCommand, { type: T }>;

export interface EffectCommandContext {
	readonly session: AgentSession;
	readonly by: EffectActor;
	/** The routing handle this session is answered on, absent on a classic connection. */
	readonly sessionId?: string;
}

type EffectResponse = Extract<
	RpcResponse,
	{
		success: true;
		command:
			| "abort"
			| "set_model"
			| "set_thinking_level"
			| "get_effect_status"
			| "dequeue_message"
			| "edit_queued_message";
	}
>;
type ResponsePayload<T> = T extends EffectResponse ? Omit<T, "id" | "type" | "success"> : never;

function respond(id: string | undefined, response: ResponsePayload<EffectResponse>): RpcResponse {
	return { ...response, id, type: "response", success: true };
}

function refuse(
	id: string | undefined,
	command: string,
	message: string,
	errorCode: string | undefined,
	errorData: unknown,
): RpcResponse {
	return {
		id,
		type: "response",
		command,
		success: false,
		error: message,
		...(errorCode === undefined ? {} : { errorCode }),
		...(errorData === undefined ? {} : { errorData }),
	};
}

export function effectAnswer(status: EffectStatus, sessionId: string | undefined, replayed = false): RpcEffectAnswer {
	const effect = sessionId === undefined ? status : { ...status, sessionId };
	return { effectId: status.effectId, state: status.state, effect, ...(replayed ? { replayed: true } : {}) };
}

export async function beginEffect(
	ctx: EffectCommandContext,
	kind: EffectCommandKind,
	command: { readonly id?: string; readonly type: string; readonly effectId: string },
): Promise<EffectBegin | RpcResponse> {
	try {
		return await EffectLedger.forSession(ctx.session).begin(kind, command.effectId, command, ctx.by);
	} catch (cause) {
		if (!(cause instanceof EffectIdConflict)) throw cause;
		return refuse(command.id, command.type, cause.message, RPC_ERROR_EFFECT_ID_CONFLICT, {
			effectId: cause.effectId,
			reason: cause.reason,
			action: cause.action,
		});
	}
}

function isResponse(value: EffectBegin | RpcResponse): value is RpcResponse {
	return "type" in value;
}

export function isEffectBegin(value: EffectBegin | RpcResponse): value is EffectBegin {
	return !isResponse(value);
}

function invalidGrace(command: Command<"abort">): RpcResponse | undefined {
	const { graceMs } = command;
	if (graceMs === undefined) return undefined;
	if (isAbortGraceInRange(graceMs)) return undefined;
	const reason = "invalid_grace_ms";
	const action = `send graceMs as a whole number of milliseconds from 0 to ${ABORT_MAX_GRACE_MS}`;
	return refuse(
		command.id,
		"abort",
		`graceMs must be an integer from 0 to ${ABORT_MAX_GRACE_MS}`,
		RPC_ERROR_INVALID_ARGUMENT,
		{
			reason,
			action,
		},
	);
}

/** Resolves true once `aborting` settles with the session idle, false when `graceMs` runs out first. */
async function quiesce(session: AgentSession, aborting: Promise<void>, graceMs: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), graceMs);
	});
	try {
		return await Promise.race([aborting.then(() => !session.isStreaming), expired]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * `abort`: with `clearQueue` the queued inputs are drained (each gets a `cleared` receipt) before
 * the abort; with `awaitIdle` the answer waits until the session is idle or `graceMs` passes. Without
 * either, the abort is acknowledged on dispatch exactly as before.
 */
export async function runAbort(
	ctx: EffectCommandContext,
	command: Command<"abort">,
	dispatch: () => Promise<void>,
): Promise<RpcResponse> {
	const invalid = invalidGrace(command);
	if (invalid !== undefined) return invalid;
	const { effectId } = command;
	const quiesced = command.awaitIdle === true || command.clearQueue === true;
	const begun = effectId === undefined ? undefined : await beginEffect(ctx, "abort", { ...command, effectId });
	if (begun !== undefined && isResponse(begun)) return begun;
	if (begun !== undefined && "replay" in begun)
		return respond(command.id, { command: "abort", data: effectAnswer(begun.replay, ctx.sessionId, true) });
	const admissions = ClientAdmissions.forSession(ctx.session);
	const streaming = ctx.session.isStreaming;
	let cleared = 0;
	if (command.clearQueue === true) {
		admissions.clearQueued();
		const drained = ctx.session.clearQueue({ abortWillFollow: true });
		cleared = drained.steering.length + drained.followUp.length;
	}
	const noted = admissions.noteAbort(ctx.by, effectId);
	const aborting = dispatch();
	// No turn to name: once this abort settled (its session_abort, if any, already read it), forget it,
	// unless a newer abort has been recorded since.
	if (!streaming) void aborting.finally(() => admissions.forgetAbort(noted));
	const ledger = effectId === undefined ? undefined : EffectLedger.forSession(ctx.session);
	let status =
		effectId === undefined
			? undefined
			: streaming
				? ledger?.transition(effectId, "applied")
				: ledger?.transition(effectId, "done", { disposition: "no_active_turn" });
	if (!quiesced)
		return respond(command.id, {
			command: "abort",
			...(status === undefined ? {} : { data: effectAnswer(status, ctx.sessionId) }),
		});
	const idle =
		command.awaitIdle === true
			? await quiesce(ctx.session, aborting, command.graceMs ?? ABORT_DEFAULT_GRACE_MS)
			: !streaming;
	// The ledger moves an applied abort to `done` on `agent_idle`; read it again after the wait.
	if (effectId !== undefined) status = ledger?.status(effectId) ?? status;
	return respond(command.id, {
		command: "abort",
		data: { ...(status === undefined ? {} : effectAnswer(status, ctx.sessionId)), stopped: idle, idle, cleared },
	});
}

/**
 * `dequeue_message` / `edit_queued_message`: one queued input, by `queuedId`. With `effectId` the change is a ledger
 * effect: `done` when it removed or edited the input, `failed` with an outcome when the input was already delivered
 * or no longer exists.
 */
export async function runQueuedInputChange(
	ctx: EffectCommandContext,
	command: Command<"dequeue_message"> | Command<"edit_queued_message">,
): Promise<RpcResponse> {
	const kind = command.type === "dequeue_message" ? "dequeue" : "edit_queued";
	const { effectId, queuedId } = command;
	const begun = effectId === undefined ? undefined : await beginEffect(ctx, kind, { ...command, effectId });
	if (begun !== undefined && isResponse(begun)) return begun;
	if (begun !== undefined && "replay" in begun)
		return respond(command.id, {
			command: command.type,
			data: {
				queuedId,
				status: replayedStatus(begun.replay, command.type),
				...begun.replay.answer,
				...(begun.replay.outcome === undefined
					? {}
					: { reason: begun.replay.outcome.reason, action: begun.replay.outcome.action }),
				...effectAnswer(begun.replay, ctx.sessionId, true),
			},
		});
	const clientMessageId = ctx.session.getQueuedInputs().find((input) => input.queuedId === queuedId)?.clientMessageId;
	const expected = command.expectedRevision === undefined ? undefined : { expectedRevision: command.expectedRevision };
	const status = await ctx.session.changeQueuedInput(
		queuedId,
		command.type === "dequeue_message" ? undefined : command.text,
		{ ...expected, ...(effectId === undefined ? {} : { effectId }) },
	);
	// Read right after the change, before anything else on this command: the revision the answer reports is the one
	// it made or met.
	const current = ctx.session.getQueuedInputs().find((input) => input.queuedId === queuedId);
	// A durable input is restored from its admission record on reopen: that record must carry the edit too.
	if (status === "edited" && clientMessageId !== undefined && command.type === "edit_queued_message")
		ClientAdmissions.forSession(ctx.session).editQueuedText(clientMessageId, command.text);
	const outcome =
		status === "already_delivered"
			? EFFECT_OUTCOMES.queuedInputAlreadyDelivered
			: status === "not_found"
				? EFFECT_OUTCOMES.queuedInputNotFound
				: status === "conflict"
					? EFFECT_OUTCOMES.queuedInputConflict
					: undefined;
	const answer =
		status === "edited" && current !== undefined
			? { text: current.text, revision: current.revision }
			: status === "conflict" && current !== undefined
				? { currentRevision: current.revision }
				: undefined;
	// The receipt keeps the answer too: a same-id retry after a dropped response must answer exactly as this call did.
	const stored = answer === undefined ? {} : { answer };
	const ledger = effectId === undefined ? undefined : EffectLedger.forSession(ctx.session);
	const recorded =
		effectId === undefined || ledger === undefined
			? undefined
			: outcome === undefined
				? ledger.transition(effectId, "done", { disposition: status, ...stored })
				: ledger.transition(effectId, "failed", { outcome, ...stored });
	return respond(command.id, {
		command: command.type,
		data: {
			queuedId,
			status,
			...answer,
			...(outcome === undefined ? {} : { reason: outcome.reason, action: outcome.action }),
			...(recorded === undefined ? {} : effectAnswer(recorded, ctx.sessionId)),
		},
	});
}

function replayedStatus(status: EffectStatus, command: "dequeue_message" | "edit_queued_message") {
	if (
		status.outcome?.kind === "already_delivered" ||
		status.outcome?.kind === "not_found" ||
		status.outcome?.kind === "conflict"
	)
		return status.outcome.kind;
	return command === "dequeue_message" ? ("removed" as const) : ("edited" as const);
}

export async function runSetModel(ctx: EffectCommandContext, command: Command<"set_model">): Promise<RpcResponse> {
	const { effectId } = command;
	const begun = effectId === undefined ? undefined : await beginEffect(ctx, "set_model", { ...command, effectId });
	if (begun !== undefined && isResponse(begun)) return begun;
	if (begun !== undefined && "replay" in begun)
		return respond(command.id, { command: "set_model", data: effectAnswer(begun.replay, ctx.sessionId, true) });
	const ledger = effectId === undefined ? undefined : EffectLedger.forSession(ctx.session);
	const models = await ctx.session.modelRegistry.getAvailable();
	const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
	if (!model) {
		const message = `Model not found: ${command.provider}/${command.modelId}`;
		const failed =
			effectId === undefined
				? undefined
				: ledger?.transition(effectId, "failed", {
						outcome: unknownModelOutcome(command.provider, command.modelId),
					});
		return refuse(
			command.id,
			"set_model",
			message,
			RPC_ERROR_MODEL_NOT_FOUND,
			failed && effectAnswer(failed, ctx.sessionId),
		);
	}
	if (effectId === undefined || ledger === undefined) {
		const systemPromptChange = await ctx.session.setModel(model, { source: "rpc" });
		return respond(command.id, {
			command: "set_model",
			data: { ...model, systemPromptName: systemPromptChange?.systemPromptName },
		});
	}
	let systemPromptName: string | undefined;
	try {
		systemPromptName = (await ctx.session.setModel(model, { source: "rpc", effectId }))?.systemPromptName;
	} catch (cause) {
		if (!(cause instanceof ModelUsabilityBudgetError) && !(cause instanceof ModelSwitchAuthError)) {
			ledger.transition(effectId, "failed", {
				outcome: modelSwitchErrorOutcome(cause instanceof Error ? cause.message : String(cause)),
			});
			throw cause;
		}
		const budget = cause instanceof ModelUsabilityBudgetError;
		const failed = ledger.transition(effectId, "failed", {
			outcome: budget ? contextBudgetOutcome(cause.message) : providerUnavailableOutcome(cause.message),
		});
		return refuse(
			command.id,
			"set_model",
			cause.message,
			budget ? RPC_ERROR_CONTEXT_BUDGET : RPC_ERROR_PROVIDER_UNAVAILABLE,
			effectAnswer(failed, ctx.sessionId),
		);
	}
	// `done` was written by the ledger when `model_changed` carried this id; a switch held for compaction
	// stays `accepted` until it lands.
	const status = ledger.status(effectId);
	return respond(command.id, {
		command: "set_model",
		data: {
			...model,
			systemPromptName,
			...(status === undefined ? {} : effectAnswer(status, ctx.sessionId)),
		},
	});
}

export async function runSetThinkingLevel(ctx: EffectCommandContext, command: Command<"set_thinking_level">) {
	const { effectId } = command;
	const begun =
		effectId === undefined ? undefined : await beginEffect(ctx, "set_thinking_level", { ...command, effectId });
	if (begun !== undefined && isResponse(begun)) return begun;
	if (begun !== undefined && "replay" in begun)
		return respond(command.id, {
			command: "set_thinking_level",
			data: effectAnswer(begun.replay, ctx.sessionId, true),
		});
	const ledger = effectId === undefined ? undefined : EffectLedger.forSession(ctx.session);
	if (command.scope === "turn") {
		// Validate BEFORE mutating: the session clamps an unsupported level to a supported neighbour, so
		// applying first would leave a REJECTED request's clamped level in place.
		if (!ctx.session.getAvailableThinkingLevels().includes(command.level)) {
			const message = unsupportedThinkingLevel(command.level);
			const failed =
				effectId === undefined
					? undefined
					: ledger?.transition(effectId, "failed", { outcome: unsupportedThinkingLevelOutcome(message) });
			return refuse(
				command.id,
				"set_thinking_level",
				message,
				undefined,
				failed && effectAnswer(failed, ctx.sessionId),
			);
		}
		ctx.session.setSessionThinkingLevel(command.level, { source: "rpc", effectId });
	} else {
		ctx.session.setThinkingLevel(command.level, { source: "rpc", effectId });
	}
	if (effectId === undefined || ledger === undefined) return respond(command.id, { command: "set_thinking_level" });
	const done = ledger.transition(effectId, "done", { disposition: "applied" });
	return respond(command.id, { command: "set_thinking_level", data: effectAnswer(done, ctx.sessionId) });
}

/** `get_effect_status` on a loaded session; a `sessionPath` naming another transcript reads that file. */
export async function runGetEffectStatus(ctx: EffectCommandContext, command: Command<"get_effect_status">) {
	if (command.sessionPath !== undefined && command.sessionPath !== ctx.session.sessionFile)
		return answerEffectFromTranscript(command.id, command.sessionPath, command.effectId);
	const status = EffectLedger.forSession(ctx.session).status(command.effectId, ctx.sessionId);
	return respond(command.id, {
		command: "get_effect_status",
		data: status === undefined ? { found: false, searched: "complete" } : { found: true, effect: status },
	});
}

/** `get_effect_status { sessionPath }` for a session that is not loaded: an authoritative disk read. */
export async function answerEffectFromTranscript(id: string | undefined, path: string, effectId: string) {
	try {
		return respond(id, { command: "get_effect_status", data: await lookupEffectInTranscript(path, effectId) });
	} catch (cause) {
		if (!(cause instanceof TranscriptUnreadable)) throw cause;
		return refuse(id, "get_effect_status", cause.message, RPC_ERROR_TRANSCRIPT_UNREADABLE, {
			path: cause.path,
			reason: cause.reason,
			action: cause.action,
		});
	}
}
