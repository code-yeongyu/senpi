// DeepSeek V4.1 Flash (2026-09-10) is a new pre-train, not a V4 Flash refresh,
// so it carries none of the DEEPSEEK_V4_RULES: each of those repairs a failure
// observed on V4-Flash-0731 transcripts, and a re-trained model does not
// inherit them. DeepSeek's own scaffold comparison (tech report Table 4, same
// checkpoint) ranks the thinnest harness highest - DSH Minimal, a one-sentence
// system prompt plus bash, scores 90.6 on Terminal-Bench 2.1 vs 85.8 for DSH
// Standard - so the preset renders the shared core and the eval-routing stance
// only. A V4.1-specific rule is added against a V4.1 trace by listing this
// preset in that rule's `presets`.

import { type BuildDynamicSystemPromptOptions, buildDynamicSystemPrompt } from "../../../dynamic-prompt/build.ts";
import { buildExecutionToolingSection } from "./execution-tooling.ts";

export function buildDeepseekV41FlashPrompt(options: BuildDynamicSystemPromptOptions): string {
	return buildDynamicSystemPrompt({
		...options,
		tuningSection: buildExecutionToolingSection({ toolNames: options.selectedTools, dialect: "claude" }),
		workstationDialect: "claude",
	});
}
