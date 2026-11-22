// DeepSeek V4.1 Flash preset: one standalone core (senpi#7100).
//
// The 2026-10-31 core compressed the shared core into an RFC 2119 register with a <critical>
// block and carried four repairs written against V4 Flash traces. Ten working V4.1 Flash sessions
// on it showed which instructions lost: every session opened with a text-less todo call before
// anything was read (the forced first-turn plan beats "open every turn with one routing line"),
// 225 todo calls held 3 starts, and 72% of assistant messages were tool calls with no text
// ("Between handoffs: work without narration" was followed to the letter). The same sessions hold
// no trace that asks for the V4 repairs.
//
// V4.1 Flash reacts to conflicting instructions the way the GPT family does, so this core is a
// sibling of the gpt-6.2 one (senpi#7101): the same rules, as this preset's own copy. A cold audit
// of a draft that reworded eleven of them found no reason specific to DeepSeek for any of the
// eleven, so none was kept. It shares no text with the older DeepSeek presets.
//
// Shape:
// - Every sentence is rule data in deepseek-v4-1-flash-rules.ts: an id, the section that owns it,
//   the tools and surfaces it needs. The core renders each rule once, in table order, and drops a
//   section whose rules are all unmounted.
// - The model says how it read the request after it has looked at what the request points to, and
//   names the purpose. That reading is the goal: there is no stop-condition template and no handoff
//   block, so the preset is listed where the todo tool decides whether to cue one.
// - The core owns the todo rules (one item per thing the model will do, each closed on its own
//   result) and ties reports to events the model can observe.
// - The reading and the reasoning stay with the session. With the task tool mounted, one more
//   sentence says when a subagent starts. V4.1 sessions showed no spawn-first habit, so both are
//   preventive.
// - No capitalized or bold emphasis: "Never" appears only in the limits and the refusal rule.
//
// Left out on purpose, so a later edit does not re-add them: the RFC 2119 keyword line and the
// <critical> block, the execution-tooling paragraph (the eval tool description already carries
// batching for this model), the Test Discipline section, and the V4 repairs (directive authority,
// settled reading). Reasoning effort, sampling and the tool-call format are request plumbing and
// never prompt text.

import { APP_NAME } from "../../../../config.ts";
import {
	type BuildDynamicSystemPromptOptions,
	buildDynamicSystemPrompt,
	type DynamicPromptCoreContext,
	type PromptSurface,
} from "../../../dynamic-prompt/build.ts";
import {
	DEEPSEEK_V41_FLASH_RULES,
	DEEPSEEK_V41_FLASH_SECTIONS,
	type DeepseekV41FlashRule,
	type DeepseekV41FlashSection,
} from "./deepseek-v4-1-flash-rules.ts";

const LIST_SECTIONS: readonly DeepseekV41FlashSection[] = ["Code", "Limits"];

function activeRules(toolNames: readonly string[], surface: PromptSurface): readonly DeepseekV41FlashRule[] {
	return DEEPSEEK_V41_FLASH_RULES.filter((rule: DeepseekV41FlashRule) => {
		const hasTool = rule.requiresTool === undefined || rule.requiresTool.some((name) => toolNames.includes(name));
		return hasTool && (rule.surfaces === undefined || rule.surfaces.includes(surface));
	});
}

function buildDeepseekV41FlashCore(context: DynamicPromptCoreContext): string {
	const rules = activeRules(
		context.tools.map((tool) => tool.name),
		context.surface,
	);
	const sections = DEEPSEEK_V41_FLASH_SECTIONS.flatMap((section) => {
		const directives = rules.filter((rule) => rule.section === section).map((rule) => rule.directive);
		if (directives.length === 0) return [];
		const body = LIST_SECTIONS.includes(section)
			? directives.map((directive) => `- ${directive}`).join("\n")
			: directives.join("\n\n");
		return [`## ${section}\n\n${body}`];
	});
	// Only the guidelines: the provider request carries every tool schema, so the core renders no tool list.
	const guidelinesAt = context.toolSection.indexOf("## Tool Guidelines");
	if (guidelinesAt !== -1) sections.push(context.toolSection.slice(guidelinesAt));

	return `You are ${context.appName ?? APP_NAME}, a coding agent working in the user's workspace. You carry the user's goal to a finished, verified result: they hand you a problem and come back to find it solved.\n\n${sections.join("\n\n")}`;
}

export function buildDeepseekV41FlashPrompt(options: BuildDynamicSystemPromptOptions): string {
	return buildDynamicSystemPrompt({ ...options, corePrompt: buildDeepseekV41FlashCore, workstationDialect: "codex" });
}
