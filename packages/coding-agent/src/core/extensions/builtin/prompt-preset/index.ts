import { categorizeTools } from "../../../dynamic-prompt/tool-categorization.js";
import { buildToolSection } from "../../../dynamic-prompt/tool-section.js";
import { SettingsManager } from "../../../settings-manager.js";
import type { ExtensionAPI, ExtensionContext, ModelSelectEvent } from "../../types.js";
import { resolvePreset } from "./presets.js";
import { loadPromptPresetSettings } from "./settings.js";

function createToolSectionBuilder(event: {
	systemPromptOptions: {
		selectedTools?: string[];
		toolSnippets?: Record<string, string>;
		promptGuidelines?: string[];
	};
}): () => string {
	return () =>
		buildToolSection({
			tools: categorizeTools(event.systemPromptOptions.selectedTools ?? []),
			toolSnippets: event.systemPromptOptions.toolSnippets ?? {},
			promptGuidelines: event.systemPromptOptions.promptGuidelines ?? [],
		});
}

function getSettings(ctx: ExtensionContext): ReturnType<typeof loadPromptPresetSettings> {
	return loadPromptPresetSettings(SettingsManager.create(ctx.cwd));
}

function getPresetName(ctx: ExtensionContext, event?: Pick<ModelSelectEvent, "model">): string {
	const model = event?.model ?? ctx.model;
	if (!model) {
		return "fallback (senpi-current)";
	}
	return resolvePreset(model, getSettings(ctx))?.name ?? "fallback (senpi-current)";
}

function refreshHeader(ctx: ExtensionContext, event?: Pick<ModelSelectEvent, "model">): void {
	const presetName = getPresetName(ctx, event);
	ctx.ui.setHeader((_tui, theme) => ({
		render: () => [theme.fg("accent", theme.bold(`Prompt preset: ${presetName}`))],
		invalidate: () => {},
	}));
}

export default function promptPresetExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event, ctx) => {
		const model = ctx.model;
		if (!model) {
			return undefined;
		}

		const preset = resolvePreset(model, getSettings(ctx), createToolSectionBuilder(event));
		if (!preset) {
			return undefined;
		}

		return { systemPrompt: preset.prompt };
	});

	pi.on("session_start", async (_event, ctx) => {
		refreshHeader(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		refreshHeader(ctx, event);
	});
}
