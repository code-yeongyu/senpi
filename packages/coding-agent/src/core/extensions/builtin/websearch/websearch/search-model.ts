import { type NativeModelInfo, type NativeModelRegistry, nativeMapping, nativeRouteKey } from "./native.ts";
import type { SearchProvider } from "./types.ts";

export const SESSION_SEARCH_MODEL = "session";

// Cheaper same-provider models for hosted search, after oh-my-pi's per-provider `web-search-model` catalog axis.
// A candidate is used only when the registry lists it on the session's own route and its catalog price is lower.
const DEFAULT_SEARCH_MODELS: Partial<Record<SearchProvider, readonly string[]>> = {
	anthropic: ["claude-haiku-4-5", "claude-haiku-4.5"],
	openai: ["gpt-5.6-luna"],
	xai: ["grok-4.3"],
	deepseek: ["deepseek-v4-flash"],
};

export interface NativeSearchModelChoice {
	model: string;
	fallbackModel?: string;
	source: "session" | "setting" | "default";
	warning?: string;
}

function isCheaper(candidate: NativeModelInfo, session: NativeModelInfo): boolean {
	if (!candidate.cost || !session.cost) return false;
	const { input, output } = candidate.cost;
	const notPricier = input <= session.cost.input && output <= session.cost.output;
	return notPricier && (input < session.cost.input || output < session.cost.output);
}

function sameRouteModels(session: NativeModelInfo, registry: NativeModelRegistry | undefined): NativeModelInfo[] {
	const routeKey = nativeRouteKey(session);
	return (registry?.getAvailable?.() ?? []).filter(
		(candidate) => candidate.provider === session.provider && nativeRouteKey(candidate) === routeKey,
	);
}

function choose(model: string, session: NativeModelInfo, source: "setting" | "default"): NativeSearchModelChoice {
	return model === session.id ? { model, source } : { model, fallbackModel: session.id, source };
}

function defaultChoice(session: NativeModelInfo, candidates: NativeModelInfo[]): NativeSearchModelChoice {
	const provider = nativeMapping(session)?.provider;
	for (const id of (provider && DEFAULT_SEARCH_MODELS[provider]) || []) {
		const candidate = candidates.find((model) => model.id === id);
		if (candidate && candidate.id !== session.id && isCheaper(candidate, session)) {
			return choose(candidate.id, session, "default");
		}
	}
	return { model: session.id, source: "session" };
}

/**
 * Picks the model a native (hosted) search runs on for the session's own route. The choice always stays on
 * the session's provider, endpoint, and credential; `fallbackModel` is the session model to retry on.
 * Returns undefined when the session model has no hosted search route.
 */
export function resolveNativeSearchModel(
	session: NativeModelInfo | undefined,
	registry: NativeModelRegistry | undefined,
	setting: string | undefined,
): NativeSearchModelChoice | undefined {
	if (!session || !nativeRouteKey(session)) return undefined;
	if (setting === SESSION_SEARCH_MODEL) return { model: session.id, source: "session" };
	const candidates = sameRouteModels(session, registry);
	if (setting === undefined) return defaultChoice(session, candidates);

	const chosen =
		candidates.find((model) => model.id === setting) ??
		candidates.find((model) => `${model.provider}/${model.id}` === setting);
	if (chosen) return choose(chosen.id, session, "setting");
	return {
		model: session.id,
		source: "session",
		warning: `nativeModel "${setting}" is ignored: it is not a hosted-search model on the session's ${session.provider} route, so native search uses ${session.id}.`,
	};
}
