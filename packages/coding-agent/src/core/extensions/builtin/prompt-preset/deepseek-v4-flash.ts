import { type BuildDynamicSystemPromptOptions, buildDynamicSystemPrompt } from "../../../dynamic-prompt/build.ts";
import { buildDeepseekV4FlashIntro, buildDeepseekV4Tuning } from "./deepseek-v4.ts";

export function buildDeepseekV4FlashPrompt(options: BuildDynamicSystemPromptOptions): string {
	return buildDynamicSystemPrompt({
		...options,
		tuningSection: buildDeepseekV4Tuning("deepseek-v4-flash", buildDeepseekV4FlashIntro("DeepSeek V4 Flash")),
		workstationDialect: "claude",
	});
}
