import type { BuildDynamicSystemPromptOptions } from "../../../dynamic-prompt/build.ts";
import { buildGlm5Prompt } from "./glm-5.ts";

export function buildGlm53Prompt(options: BuildDynamicSystemPromptOptions): string {
	return buildGlm5Prompt(options);
}
