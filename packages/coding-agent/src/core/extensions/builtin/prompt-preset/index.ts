import type { BuildDynamicSystemPromptOptions } from "../../../dynamic-prompt/build.ts";
import { SettingsManager } from "../../../settings-manager.ts";
import { appendToSystemPrompt } from "../../../system-prompt.ts";
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
	customPrompt?: string;
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
	return resolvePresetName(model, getSettings(ctx));
}

function refreshHeader(ctx: ExtensionContext, event?: Pick<ModelSelectEvent, "model" | "systemPromptOptions">): void {
	if (event?.systemPromptOptions?.customPrompt !== undefined) {
		ctx.ui.setHeader(undefined);
		return;
	}
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
		const options = event.systemPromptOptions;
		if (options?.customPrompt !== undefined) {
			return undefined;
		}
		const model = ctx.model;
		if (!model) {
			return undefined;
		}

		const preset = resolvePreset(model, getSettings(ctx), eventOptionsToBuilderInput(event, ctx));
		if (!preset) {
			return undefined;
		}

		const append = options?.appendSystemPrompt;
		const replacement = appendToSystemPrompt(preset.prompt, append);
		// An earlier handler may already have appended to the chained prompt (builtin
		// hooks does this with a UserPromptSubmit systemMessage). Replacing outright
		// would discard it, so carry that exact suffix across the replacement.
		const upstream = event.systemPrompt.startsWith(event.baseSystemPrompt)
			? event.systemPrompt.slice(event.baseSystemPrompt.length)
			: "";
		return { systemPrompt: `${replacement}${upstream}` };
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.getSystemPromptOptions().customPrompt !== undefined) {
			ctx.ui.setHeader(undefined);
			return;
		}
		refreshHeader(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		refreshHeader(ctx, event);
		const options = event.systemPromptOptions;
		if (options?.customPrompt !== undefined) {
			return {
				systemPrompt: appendToSystemPrompt(options.customPrompt, options.appendSystemPrompt),
			};
		}
		const preset = resolvePreset(event.model, getSettings(ctx), eventOptionsToBuilderInput(event, ctx));
		const append = options?.appendSystemPrompt;
		return {
			systemPrompt: preset ? appendToSystemPrompt(preset.prompt, append) : null,
			systemPromptName: preset?.name,
		};
	});
}
