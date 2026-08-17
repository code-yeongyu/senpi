import type { BuildDynamicSystemPromptOptions } from "../../../dynamic-prompt/build.ts";
import { SettingsManager } from "../../../settings-manager.ts";
import type { ExtensionAPI, ExtensionContext, ModelSelectEvent } from "../../types.ts";
import { resolvePreset, resolvePresetName } from "./presets.ts";
import { loadPromptPresetSettings } from "./settings.ts";

interface SystemPromptOptionsLike {
	cwd?: string;
	selectedTools?: string[];
	toolSnippets?: Record<string, string>;
	promptGuidelines?: string[];
	contextFiles?: Array<{ path: string; content: string }>;
	skills?: BuildDynamicSystemPromptOptions["skills"];
	/** User override from --system-prompt / SDK loader; outranks any preset. */
	customPrompt?: string;
	/** User appends from --append-system-prompt, pre-joined; reapplied after a preset. */
	appendSystemPrompt?: string;
}

function eventOptionsToBuilderInput(
	event: { systemPromptOptions: SystemPromptOptionsLike | undefined },
	ctx: Pick<ExtensionContext, "cwd">,
): Partial<BuildDynamicSystemPromptOptions> {
	const options = event.systemPromptOptions ?? {};
	return {
		cwd: options.cwd ?? ctx.cwd,
		selectedTools: options.selectedTools,
		toolSnippets: options.toolSnippets,
		promptGuidelines: options.promptGuidelines,
		contextFiles: options.contextFiles,
		skills: options.skills,
	};
}

function getSettings(ctx: ExtensionContext): ReturnType<typeof loadPromptPresetSettings> {
	return loadPromptPresetSettings(SettingsManager.create(ctx.cwd));
}

function getPresetName(ctx: ExtensionContext, event?: Pick<ModelSelectEvent, "model">): string | undefined {
	const model = event?.model ?? ctx.model;
	if (!model) {
		return undefined;
	}
	if (hasUserSystemPrompt(ctx.getSystemPromptOptions?.())) {
		return undefined;
	}
	return resolvePresetName(model, getSettings(ctx));
}

function hasUserSystemPrompt(options: SystemPromptOptionsLike | undefined): boolean {
	return Boolean(options?.customPrompt);
}

function withUserAppends(presetPrompt: string, options: SystemPromptOptionsLike | undefined): string {
	const append = options?.appendSystemPrompt;
	return append ? `${presetPrompt}\n\n${append}` : presetPrompt;
}

function refreshHeader(ctx: ExtensionContext, event?: Pick<ModelSelectEvent, "model">): void {
	const presetName = getPresetName(ctx, event);
	if (!presetName) {
		ctx.ui.setHeader(undefined);
		return;
	}
	ctx.ui.setHeader((_tui, theme) => ({
		render: () => [theme.fg("accent", theme.bold(`Optimized system prompt applied: ${presetName}`))],
		invalidate: () => {},
	}));
}

export default function promptPresetExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event, ctx) => {
		const model = ctx.model;
		if (!model) {
			return undefined;
		}

		// An explicit user system prompt (--system-prompt / SDK loader override)
		// outranks the per-model preset; the base prompt already carries it.
		if (hasUserSystemPrompt(event.systemPromptOptions)) {
			return undefined;
		}

		const preset = resolvePreset(model, getSettings(ctx), eventOptionsToBuilderInput(event, ctx));
		if (!preset) {
			return undefined;
		}

		return { systemPrompt: withUserAppends(preset.prompt, event.systemPromptOptions) };
	});

	pi.on("session_start", async (_event, ctx) => {
		refreshHeader(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		refreshHeader(ctx, event);
		// Returning null resets to the base prompt, which already carries the
		// user's custom prompt and appends.
		if (hasUserSystemPrompt(event.systemPromptOptions)) {
			return { systemPrompt: null };
		}
		const preset = resolvePreset(event.model, getSettings(ctx), eventOptionsToBuilderInput(event, ctx));
		return {
			systemPrompt: preset ? withUserAppends(preset.prompt, event.systemPromptOptions) : null,
			systemPromptName: preset?.name,
		};
	});
}
