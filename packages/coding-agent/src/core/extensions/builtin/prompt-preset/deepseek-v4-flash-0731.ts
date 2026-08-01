import { type BuildDynamicSystemPromptOptions, buildDynamicSystemPrompt } from "../../../dynamic-prompt/build.ts";
import { buildDeepseekV4FlashIntro, buildDeepseekV4Tuning } from "./deepseek-v4.ts";

export function buildDeepseekV4Flash0731Prompt(options: BuildDynamicSystemPromptOptions): string {
	return buildDynamicSystemPrompt({
		...options,
		tuningSection: buildDeepseekV4Tuning(
			"deepseek-v4-flash-0731",
			buildDeepseekV4FlashIntro("DeepSeek V4 Flash (0731 snapshot)"),
		),
		workstationDialect: "claude",
	});
}
