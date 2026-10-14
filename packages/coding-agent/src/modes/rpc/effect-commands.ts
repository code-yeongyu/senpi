import type { AgentSession } from "../../core/agent-session.ts";
import { ModelUsabilityBudgetError } from "../../core/extensions/builtin/compaction/model-usability-budget.ts";
import { ModelSwitchAuthError } from "../../core/model-switch-auth-error.ts";
import { ClientAdmissions } from "./client-admissions.ts";
import { type EffectBegin, EffectLedger } from "./effect-ledger.ts";
import {
	contextBudgetOutcome,
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
	{ success: true; command: "abort" | "set_model" | "set_thinking_level" | "get_effect_status" }
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

function answer(status: EffectStatus, sessionId: string | undefined, replayed = false): RpcEffectAnswer {
	const effect = sessionId === undefined ? status : { ...status, sessionId };
	return { effectId: status.effectId, state: status.state, effect, ...(replayed ? { replayed: true } : {}) };
}

async function begin(
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

export async function runAbort(ctx: EffectCommandContext, command: Command<"abort">, dispatch: () => void) {
	const { effectId } = command;
	if (effectId === undefined) {
		ClientAdmissions.forSession(ctx.session).noteAbort(ctx.by);
		dispatch();
		return respond(command.id, { command: "abort" });
	}
	const begun = await begin(ctx, "abort", { ...command, effectId });
	if (isResponse(begun)) return begun;
	if ("replay" in begun)
		return respond(command.id, { command: "abort", data: answer(begun.replay, ctx.sessionId, true) });
	ClientAdmissions.forSession(ctx.session).noteAbort(ctx.by);
	const streaming = ctx.session.isStreaming;
	dispatch();
	const ledger = EffectLedger.forSession(ctx.session);
	const status = streaming
		? ledger.transition(effectId, "applied")
		: ledger.transition(effectId, "done", { disposition: "no_active_turn" });
	return respond(command.id, { command: "abort", data: answer(status, ctx.sessionId) });
}

export async function runSetModel(ctx: EffectCommandContext, command: Command<"set_model">): Promise<RpcResponse> {
	const { effectId } = command;
	const begun = effectId === undefined ? undefined : await begin(ctx, "set_model", { ...command, effectId });
	if (begun !== undefined && isResponse(begun)) return begun;
	if (begun !== undefined && "replay" in begun)
		return respond(command.id, { command: "set_model", data: answer(begun.replay, ctx.sessionId, true) });
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
			failed && answer(failed, ctx.sessionId),
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
			answer(failed, ctx.sessionId),
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
			...(status === undefined ? {} : answer(status, ctx.sessionId)),
		},
	});
}

export async function runSetThinkingLevel(ctx: EffectCommandContext, command: Command<"set_thinking_level">) {
	const { effectId } = command;
	const begun = effectId === undefined ? undefined : await begin(ctx, "set_thinking_level", { ...command, effectId });
	if (begun !== undefined && isResponse(begun)) return begun;
	if (begun !== undefined && "replay" in begun)
		return respond(command.id, {
			command: "set_thinking_level",
			data: answer(begun.replay, ctx.sessionId, true),
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
			return refuse(command.id, "set_thinking_level", message, undefined, failed && answer(failed, ctx.sessionId));
		}
		ctx.session.setSessionThinkingLevel(command.level, { source: "rpc", effectId });
	} else {
		ctx.session.setThinkingLevel(command.level, { source: "rpc", effectId });
	}
	if (effectId === undefined || ledger === undefined) return respond(command.id, { command: "set_thinking_level" });
	const done = ledger.transition(effectId, "done", { disposition: "applied" });
	return respond(command.id, { command: "set_thinking_level", data: answer(done, ctx.sessionId) });
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
