import type { Api, Model } from "@earendil-works/pi-ai";
import {
	ModelUsabilityBudgetError,
	type ModelUsabilityBudgetProjection,
} from "./extensions/builtin/compaction/model-usability-budget.ts";
import type { InitialModelProvenance } from "./model-resolver.ts";
import { type ProviderAuthStatusSource, selectProviderDefault } from "./provider-default-selection.ts";

export function isAutomaticPick(provenance: InitialModelProvenance | undefined): boolean {
	return provenance === "provider-default" || provenance === "first-available";
}

/**
 * The model an automatic startup pick moves to when its first choice cannot start: the next one the
 * same automatic order would choose (`selectProviderDefault`) among the remaining available models,
 * skipping every model `canStart` refuses (senpi#3333).
 */
export function nextStartableModel(
	available: readonly Model<Api>[],
	rejected: Model<Api>,
	canStart: (model: Model<Api>) => boolean,
	providerDefaults: Readonly<Record<string, string>>,
	source: ProviderAuthStatusSource,
): Model<Api> | undefined {
	let remaining = available.filter((model) => !(model.provider === rejected.provider && model.id === rejected.id));
	while (remaining.length > 0) {
		const candidate = selectProviderDefault(remaining, providerDefaults, source)?.model;
		if (candidate === undefined) return undefined;
		if (canStart(candidate)) return candidate;
		remaining = remaining.filter((model) => model !== candidate);
	}
	return undefined;
}

export function startupReplacementMessage(replacement: Model<Api>, refused: ModelUsabilityBudgetProjection): string {
	return `No usable default model is set, so ${replacement.provider}/${replacement.id} was chosen: ${refused.model} has a ${refused.contextWindow}-token context window and needs ${refused.requiredTokens} to start. Use /model to pick another, or set a default model.`;
}

export function startupRefusalMessage(refused: ModelUsabilityBudgetProjection, automatic: boolean): string {
	const why = `${refused.model} cannot start: its context window is ${refused.contextWindow} tokens and starting needs ${refused.requiredTokens}.`;
	return automatic
		? `${why} It was picked automatically because no usable default model is set, and no other available model fits. Add a provider with a larger model (/login), or pass --model <provider>/<id>.`
		: `${why} Choose a model with a larger context window (--model <provider>/<id>, or /model).`;
}

type StartAdmission = {
	assertModelUsable(model: Model<Api>, liveContextTokens: number, options: { admission: "start" }): void;
};

export function canStartOn(session: StartAdmission, model: Model<Api>): boolean {
	try {
		session.assertModelUsable(model, 0, { admission: "start" });
		return true;
	} catch (error) {
		if (error instanceof ModelUsabilityBudgetError) return false;
		throw error;
	}
}
