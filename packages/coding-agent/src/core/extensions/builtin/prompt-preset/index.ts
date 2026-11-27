import type { Api, Model } from "@earendil-works/pi-ai";
import type { BuildDynamicSystemPromptOptions, FullToolPrompt } from "../../../dynamic-prompt/build.ts";
import { SettingsManager } from "../../../settings-manager.ts";
import { isAnthropicWebSearchEnabled, supportsNativeAnthropicWebSearch } from "../anthropic-web-search/index.ts";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
} from "../../types.ts";
import { resolveActivePresetName } from "./active-preset.ts";
import { resolvePreset } from "./presets.ts";
import { loadPromptPresetSettings } from "./settings.ts";

interface SystemPromptOptionsLike {
	cwd?: string;
	selectedTools?: string[];
	toolSnippets?: Record<string, string>;
	promptGuidelines?: string[];
	fullToolPrompt?: FullToolPrompt;
	contextFiles?: Array<{ path: string; content: string }>;
	skills?: BuildDynamicSystemPromptOptions["skills"];
	surface?: BuildDynamicSystemPromptOptions["surface"];
	/** User override from --system-prompt / SDK loader; outranks any preset. */
	customPrompt?: string;
	/** User appends from --append-system-prompt, pre-joined; reapplied after a preset. */
	appendSystemPrompt?: string;
}

/** Whether the model can search through Anthropic-native web search on this request (senpi#2935). */
function hasNativeAnthropicSearch(model: Model<Api> | undefined): boolean {
	return model !== undefined && supportsNativeAnthropicWebSearch(model) && isAnthropicWebSearchEnabled();
}

function eventOptionsToBuilderInput(
	event: { systemPromptOptions: SystemPromptOptionsLike | undefined },
	ctx: Pick<ExtensionContext, "cwd">,
	model: Model<Api> | undefined,
): Partial<BuildDynamicSystemPromptOptions> {
	const options = event.systemPromptOptions ?? {};
	return {
		cwd: options.cwd ?? ctx.cwd,
		selectedTools: options.selectedTools,
		toolSnippets: options.toolSnippets,
		promptGuidelines: options.promptGuidelines,
		fullToolPrompt: options.fullToolPrompt,
		contextFiles: options.contextFiles,
		skills: options.skills,
		surface: options.surface,
		nativeSearchAvailable: hasNativeAnthropicSearch(model),
	};
}

function getSettings(ctx: ExtensionContext): ReturnType<typeof loadPromptPresetSettings> {
	return loadPromptPresetSettings(SettingsManager.create(ctx.cwd));
}

function hasUserSystemPrompt(options: SystemPromptOptionsLike | undefined): boolean {
	return Boolean(options?.customPrompt);
}

function withUserAppends(presetPrompt: string, options: SystemPromptOptionsLike | undefined): string {
	const append = options?.appendSystemPrompt;
	return append ? `${presetPrompt}\n\n${append}` : presetPrompt;
}

/**
 * The header is the first row of the transcript, so it is set once at session start and never rewritten:
 * a model switch would otherwise change a row far above the screen, and the renderer can only show that by
 * clearing the scrollback and replaying the whole transcript (sisyphuslabs/doriterm#2745). The switch is
 * announced by the model status row instead.
 */
function setStartupHeader(ctx: ExtensionContext): void {
	const presetName = resolveActivePresetName(ctx, ctx.model);
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
	const onBeforeAgentStart: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult> = async (
		event,
		ctx,
	) => {
		const model = ctx.model;
		if (!model) {
			return undefined;
		}

		// An explicit user system prompt (--system-prompt / SDK loader override)
		// outranks the per-model preset; the base prompt already carries it.
		if (hasUserSystemPrompt(event.systemPromptOptions)) {
			return undefined;
		}

		const preset = resolvePreset(model, getSettings(ctx), eventOptionsToBuilderInput(event, ctx, model));
		if (!preset) {
			return undefined;
		}

		const append = event.systemPromptOptions.appendSystemPrompt;
		return {
			systemPrompt: withUserAppends(preset.prompt, event.systemPromptOptions),
			systemPromptParts: [
				...preset.parts,
				...(append ? [{ name: "append_system_prompt", source: "loader", text: `\n\n${append}` }] : []),
			],
		};
	};
	pi.on("before_agent_start", onBeforeAgentStart, { previewSafe: true });

	pi.on("session_start", async (_event, ctx) => {
		setStartupHeader(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		// Returning null resets to the base prompt, which already carries the
		// user's custom prompt and appends.
		if (hasUserSystemPrompt(event.systemPromptOptions)) {
			return { systemPrompt: null };
		}
		const preset = resolvePreset(event.model, getSettings(ctx), eventOptionsToBuilderInput(event, ctx, event.model));
		return {
			systemPrompt: preset ? withUserAppends(preset.prompt, event.systemPromptOptions) : null,
			systemPromptName: preset?.name,
		};
	});
}
