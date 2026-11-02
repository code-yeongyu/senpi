import type { BuildDynamicSystemPromptOptions } from "../../../dynamic-prompt/build.ts";
import { buildKimiK2CodePrompt } from "./kimi-k2-code.ts";

export function buildKimiK27Prompt(options: BuildDynamicSystemPromptOptions): string {
	return buildKimiK2CodePrompt(options, "Kimi K2.7");
}
