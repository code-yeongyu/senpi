import {
	type BuildDynamicSystemPromptOptions as NativeOptions,
	buildDynamicSystemPrompt as nativeDefault,
} from "../../../dynamic-prompt/build.ts";
import type { ResolvedPresetName } from "./contract.ts";
import type { ModelWithPromptPresetMetadata } from "./matchers.ts";
import { buildPreset as nativePreset, resolvePreset as nativeResolve, type ResolvedPromptPreset } from "./presets.ts";
import type { PromptPresetSettings } from "./settings.ts";

export type BuildDynamicSystemPromptOptions = Pick<
	NativeOptions,
	"appName" | "cwd" | "selectedTools" | "toolSnippets" | "promptGuidelines" | "contextFiles" | "skills" | "surface"
>;

export const buildDynamicSystemPrompt: (options: BuildDynamicSystemPromptOptions) => string = nativeDefault;
export const buildPreset: (name: ResolvedPresetName, options: BuildDynamicSystemPromptOptions) => ResolvedPromptPreset =
	nativePreset;
export const resolvePreset: (
	model: ModelWithPromptPresetMetadata,
	settings: PromptPresetSettings,
	options?: Partial<BuildDynamicSystemPromptOptions>,
) => ResolvedPromptPreset | undefined = nativeResolve;
