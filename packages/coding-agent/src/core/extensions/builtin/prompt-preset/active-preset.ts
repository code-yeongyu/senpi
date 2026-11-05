import type { SharedSections } from "../../../dynamic-prompt/types.ts";
import { SettingsManager } from "../../../settings-manager.ts";
import type { ExtensionContext } from "../../types.ts";
import { presetSharedSections, type ResolvedPresetName } from "./contract.ts";
import { resolvePresetName } from "./presets.ts";
import { loadPromptPresetSettings } from "./settings.ts";

type PresetContext = Pick<ExtensionContext, "cwd" | "model" | "getSystemPromptOptions">;

/**
 * The preset this extension renders for `model` (default: the context's model), or undefined when none
 * applies: no model, or a user system prompt (--system-prompt / SDK loader override) outranks presets.
 */
export function resolveActivePresetName(
	ctx: PresetContext,
	model: ExtensionContext["model"] = ctx.model,
): ResolvedPresetName | undefined {
	if (!model) return undefined;
	if (ctx.getSystemPromptOptions?.()?.customPrompt) return undefined;
	return resolvePresetName(model, loadPromptPresetSettings(SettingsManager.create(ctx.cwd)));
}

/**
 * The shared-section wording of the active preset (senpi#5665), for extensions that append their own
 * shared prompt text after the preset renders (terminal, todotools, websearch, bash-timeout).
 */
export function activeSharedSections(ctx: PresetContext): SharedSections {
	return presetSharedSections(resolveActivePresetName(ctx));
}
