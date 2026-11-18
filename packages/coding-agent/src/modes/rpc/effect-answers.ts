/**
 * How a command that carries an `effectId` is answered: the response builders, and what the session's effect ledger
 * says about that id, both when the command begins (recorded) and when it only asks (nothing recorded).
 */
import type { AgentSession } from "../../core/agent-session.ts";
import { type EffectBegin, EffectLedger } from "./effect-ledger.ts";
import { type EffectActor, type EffectCommandKind, EffectIdConflict, type EffectStatus } from "./effect-record.ts";
import { RPC_ERROR_EFFECT_ID_CONFLICT, type RpcEffectAnswer, type RpcResponse } from "./rpc-types.ts";

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

export function respond(id: string | undefined, response: ResponsePayload<EffectResponse>): RpcResponse {
	return { ...response, id, type: "response", success: true };
}

export function refuse(
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
		return conflictRefusal(command, cause);
	}
}

/**
 * What a command carrying this `effectId` would be answered from the ledger, with nothing recorded (a dry run): the
 * stored status to replay, the `effect_id_conflict` refusal for another payload, or nothing for a fresh id.
 */
export function recordedEffect(
	session: AgentSession,
	kind: EffectCommandKind,
	command: { readonly id?: string; readonly type: string; readonly effectId: string },
): EffectStatus | RpcResponse | undefined {
	try {
		return EffectLedger.forSession(session).recorded(kind, command.effectId, command);
	} catch (cause) {
		return conflictRefusal(command, cause);
	}
}

function conflictRefusal(command: { readonly id?: string; readonly type: string }, cause: unknown): RpcResponse {
	if (!(cause instanceof EffectIdConflict)) throw cause;
	return refuse(command.id, command.type, cause.message, RPC_ERROR_EFFECT_ID_CONFLICT, {
		effectId: cause.effectId,
		reason: cause.reason,
		action: cause.action,
	});
}

export function isResponse(value: EffectBegin | RpcResponse): value is RpcResponse {
	return "type" in value;
}

export function isEffectBegin(value: EffectBegin | RpcResponse): value is EffectBegin {
	return !isResponse(value);
}
