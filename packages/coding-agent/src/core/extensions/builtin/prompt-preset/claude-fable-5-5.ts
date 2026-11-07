import type { BuildDynamicSystemPromptOptions } from "../../../dynamic-prompt/build.ts";
import { buildClaudeFable51Prompt } from "./claude-fable-5-1.ts";

// Launch baseline only: retain the current dieted 5.1 core and all later tuning.
// No Fable 5.5 prompting guide or new model-specific behavior is asserted.
export function buildClaudeFable55Prompt(options: BuildDynamicSystemPromptOptions): string {
	return buildClaudeFable51Prompt(options);
}
