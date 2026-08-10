import { APP_NAME } from "../../../../config.ts";
import type { TipDefinition } from "./types.ts";

export const MODEL_TIPS = [
	{
		id: "thinking-level",
		bindings: ["app.thinking.cycle"],
		render: (keys) => `Use ${keys("app.thinking.cycle")} to cycle the model's thinking level.`,
	},
	{
		id: "favorite-model-rotation",
		bindings: ["app.model.cycleForward", "app.model.cycleBackward"],
		render: (keys) =>
			`Rotate through favorite models with ${keys("app.model.cycleForward")}; go backward with ${keys("app.model.cycleBackward")}.`,
	},
	{
		id: "model-selector-favorites",
		bindings: ["app.model.select", "app.models.toggleFavorite"],
		render: (keys) =>
			`Open the model selector with ${keys("app.model.select")}, then use ${keys("app.models.toggleFavorite")} to toggle the highlighted favorite.`,
	},
	{
		id: "model-command-search",
		bindings: [],
		render: () => "Use /model to open the selector, or /model <pattern> to jump straight to a matching model.",
	},
	{
		id: "model-cycling-scope",
		bindings: ["app.model.cycleForward"],
		render: (keys) =>
			`Start ${APP_NAME} with --models "anthropic/*,gpt-5*" to limit which models ${keys("app.model.cycleForward")} cycles through.`,
	},
	{
		id: "thinking-budgets",
		bindings: [],
		render: () => "Set thinkingBudgets in settings.json to choose the token budget behind each thinking level.",
	},
	{
		id: "prompt-preset",
		bindings: [],
		render: () => "Set promptPreset in settings.json when a model does not auto-detect the system prompt you want.",
	},
	{
		id: "provider-login",
		bindings: [],
		render: () => "Use /login to add a subscription or API-key provider, and /logout to remove stored credentials.",
	},
	{
		id: "fallback-chains-setting",
		bindings: [],
		render: () =>
			"retry.fallbackChains in settings.json maps a model to ordered fallbacks, so a failed turn retries on the next one.",
	},
	{
		id: "fallback-command",
		bindings: [],
		requiresCommand: "fallback",
		render: () => "Use /fallback to inspect and manage the retry fallback chain for the current model.",
	},
] satisfies readonly TipDefinition[];
