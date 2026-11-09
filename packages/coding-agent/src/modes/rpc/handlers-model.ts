/**
 * The model commands of a session connection: `set_model`, `set_favorite_models`, `set_scoped_models`, `cycle_model`
 * and `get_available_models`. `set_model { scope: "session" }` switches only the routed session (`setSessionModel`):
 * the default model in the device-wide settings stays, which is what lets a caller granted `drive` send it (rule
 * `set_model@1` in `method-classes.ts`). Without a scope, `set_model` persists the default model as it always has.
 */
import type { AgentSession } from "../../core/agent-session.ts";
import { ModelUsabilityBudgetError } from "../../core/extensions/builtin/compaction/model-usability-budget.ts";
import { ModelSwitchAuthError } from "../../core/model-switch-auth-error.ts";
import {
	beginEffect,
	type EffectCommandContext,
	effectAnswer,
	isEffectBegin,
	refuse,
	respond,
} from "./effect-commands.ts";
import { EffectLedger } from "./effect-ledger.ts";
import {
	contextBudgetOutcome,
	modelSwitchErrorOutcome,
	providerUnavailableOutcome,
	unknownModelOutcome,
} from "./effect-outcome-copy.ts";
import {
	RPC_ERROR_CONTEXT_BUDGET,
	RPC_ERROR_MODEL_NOT_FOUND,
	RPC_ERROR_PROVIDER_UNAVAILABLE,
	type RpcCommand,
	type RpcResponse,
} from "./rpc-types.ts";
import { availableModelsData } from "./session-control-actions-data.ts";

type Command<T extends RpcCommand["type"]> = Extract<RpcCommand, { type: T }>;

export type RpcModelCommand = Command<
	"set_model" | "set_favorite_models" | "set_scoped_models" | "cycle_model" | "get_available_models"
>;

function success<T extends RpcCommand["type"]>(id: string | undefined, command: T, data?: unknown): RpcResponse {
	if (data === undefined) {
		return { id, type: "response", command, success: true } as RpcResponse;
	}
	return { id, type: "response", command, success: true, data } as RpcResponse;
}

export async function handleModelCommand(ctx: EffectCommandContext, command: RpcModelCommand): Promise<RpcResponse> {
	const { id } = command;
	switch (command.type) {
		case "set_model":
			return runSetModel(ctx, command);
		case "set_favorite_models":
			ctx.session.setFavoriteModels(command.models);
			return success(id, "set_favorite_models");
		case "set_scoped_models":
			ctx.session.setScopedModels(command.models);
			return success(id, "set_scoped_models");
		case "cycle_model": {
			const result = await ctx.session.cycleModel(command.direction, {
				origin: { source: "rpc", actor: "cycle_model" },
			});
			return success(id, "cycle_model", result ?? null);
		}
	}
	return success(id, "get_available_models", await availableModelsData(ctx.session));
}

function switchModel(
	session: AgentSession,
	scope: Command<"set_model">["scope"],
	...change: Parameters<AgentSession["setModel"]>
) {
	return scope === "session" ? session.setSessionModel(...change) : session.setModel(...change);
}

export async function runSetModel(ctx: EffectCommandContext, command: Command<"set_model">): Promise<RpcResponse> {
	const { effectId } = command;
	const begun = effectId === undefined ? undefined : await beginEffect(ctx, "set_model", { ...command, effectId });
	if (begun !== undefined && !isEffectBegin(begun)) return begun;
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
		const systemPromptChange = await switchModel(ctx.session, command.scope, model, { source: "rpc" });
		return respond(command.id, {
			command: "set_model",
			data: { ...model, systemPromptName: systemPromptChange?.systemPromptName },
		});
	}
	let systemPromptName: string | undefined;
	try {
		systemPromptName = (await switchModel(ctx.session, command.scope, model, { source: "rpc", effectId }))
			?.systemPromptName;
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
