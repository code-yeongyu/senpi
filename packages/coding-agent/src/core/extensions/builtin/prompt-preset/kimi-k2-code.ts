// Shared core for the Kimi K2 coding family (K2.7 Code, K2.8 Preview).
//
// Moonshot ships K2.8 Preview as the in-place successor to K2.7 Code on Kimi
// Code's rolling `kimi-for-coding` model id: same family, same coding-agent
// posture, an efficiency and context upgrade rather than a new prompting
// contract. Both presets therefore render this core verbatim and differ only in
// the model name they announce.
// https://www.kimi.com/code/docs/en/kimi-code/models.html (checked 2026-09-18)
import {
	type BuildDynamicSystemPromptOptions,
	buildDynamicSystemPrompt,
	type PromptSurface,
} from "../../../dynamic-prompt/build.ts";
import { buildExecutionToolingSection } from "./execution-tooling.ts";

function buildKimiK2CodeTuning(modelName: string, surface: PromptSurface): string {
	return `You are running on ${modelName} - restrained and outcome-first. Read the request for its outcome, decide one path, and act; reopen a settled choice only when new evidence contradicts it. Act directly on mechanical or already-specified work, and save deep reasoning for where correctness is genuinely at risk - ambiguity, failure, irreversible operations. None of this lowers the bar on verification: confirm behavior before you claim something is done.

${surface === "terminal" ? "The intent gate routing line is required every turn. " : ""}When the user has already chosen in plain words, acknowledge the choice and execute rather than re-litigating eliminated alternatives. Write lean - do not re-derive what you already established this turn.`;
}

export function buildKimiK2CodePrompt(options: BuildDynamicSystemPromptOptions, modelName: string): string {
	return buildDynamicSystemPrompt({
		...options,
		tuningSection: [
			buildExecutionToolingSection({ toolNames: options.selectedTools, dialect: "kimi" }),
			buildKimiK2CodeTuning(modelName, options.surface ?? "terminal"),
		]
			.filter((section) => section.length > 0)
			.join("\n\n"),
		workstationDialect: "kimi",
	});
}
