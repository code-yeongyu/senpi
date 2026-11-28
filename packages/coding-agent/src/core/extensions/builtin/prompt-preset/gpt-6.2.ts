// Read-first core for the GPT-6 Astra and GPT-6.2 presets (senpi#6979, senpi#7101).
// Both models share one prompting guide (developers.openai.com/api/docs/guides/latest-model, read
// 2026-11-18) and openai/codex ships one instructions template for both (codex-rs/models-manager/
// models.json at 5916098d02). GPT-6 Astra adopts the same core without changing its preset name.
//
// History. The first 6.2 preset (senpi#6942) was the gpt-6-astra core with five texts replaced: long
// (3,466 o200k tokens on the terminal surface) and at odds with itself for a model the guide calls
// sensitive to conflicting instructions. senpi#6979 rewrote it from the guide's four demands: name the
// outcome and the decisions that are the user's, do the work rather than propose it, check the whole
// request before calling it done, and make the final answer stand alone.
//
// The second edition answers what nine real sessions did under that core (senpi#7101): a todo list and
// often a goal before anything was read, an opener that restated the request, lists left stale for more
// than a hundred tool calls, text for the user on 12 to 20 percent of turns, "read it all" done through
// filtered slices, and subagents started before the session had opened the sources. The first core left
// the goal, the todo list and delegation to the tool descriptions and shared blocks, which disagree with
// each other, so this core states them itself.
//
// Shape:
// - Every sentence is rule data (`GPT62_RULES` in gpt-6.2-rules.ts): an id, the section that owns it,
//   the tools and surfaces it needs. The core renders each rule once, in table order, under its section.
// - One home per rule. A turn ends early only to wait for a wake or in the cases `user-stops` lists, and
//   every other section points there. There is no attempt cap: three failed approaches trigger a re-read.
// - The order is part of the instruction. Intent Gate asks for the situation behind the request first,
//   then an opener with two slots (what the user wants, what it is for), said after the first look when
//   the request's meaning sits in what it points at. The terminal gets it as the "I read this as" line;
//   the app surface carries no reply template (senpi#2377), so it asks for the same content in plain
//   sentences, and chat replies carry none. "Goal and plan" follows,
//   so a registered goal and the todo list are written from that understanding. The harness does not
//   force a first-turn todo call under this preset and does not append Task_Management after it
//   (`presetFirstTurnPlanDefault`, `presetOwnsTodoRules` in contract.ts).
// - Asking and choosing do not overlap. `user-stops` asks when the outcome itself is unclear and the
//   candidates call for materially different work; `no-early-stop` chooses, as this user would, when the
//   outcome is clear and only the way to it is open.
// - A continuation prompt, reminder or notification the harness injects is not a new request
//   (`whole-request`), so the opener is said once per request.
// - The todo rules use the tool's own terms. The tool keeps one item in progress (a cursor), so
//   `todo-fresh` describes a cursor, and `todo-plan` sizes both the threshold and an item in tool calls.
// - Depth is a condition: edit when you can explain the mechanism and why the change produces the
//   result, ask why the cause is there, and let the goal decide how far down to go.
// - Reading belongs to the session. What the user names is read in full, and a subagent takes only a
//   side task stated after looking, or one the user, their instruction files or a workflow they started
//   (a skill, ultrawork) asks for. That is all the delegation guidance the core carries.
// - Reporting names its moments (an item closes, a finding, a decision of the session's own, an
//   obstacle) and an update never ends the turn, so the core needs no handoff block and no
//   stop-condition template.
// - The user's instruction files count as standing authorization for commits and the other gated actions:
//   a file that permits commits is enough, it does not have to ask for one.
// - No capitalized or bold emphasis: "Never" opens only the limits and the refusal rule (the guide's
//   predecessor: absolutes for true invariants only).
// - Harness facts the model cannot derive are short sentences bound to the tools they describe
//   (`background-runs`). Tool schemas and the eval and terminal descriptions carry eval routing and
//   symbol lookups, so the core does not restate them.
//
// Left out on purpose, so a later edit does not re-add them: codex's Writing style list (the 6.2 guide
// says the model is concise and direct by default and asks to revisit style rules; `reader-first` keeps
// the sentences that change behavior), the code-review and formatting conventions, and the persona lines
// the older GPT cores share.

import { APP_NAME } from "../../../../config.ts";
import {
	type BuildDynamicSystemPromptOptions,
	buildDynamicSystemPrompt,
	type DynamicPromptCoreContext,
	type PromptSurface,
} from "../../../dynamic-prompt/build.ts";
import { GPT62_RULES, GPT62_SECTIONS, type Gpt62Rule, type Gpt62Section } from "./gpt-6.2-rules.ts";

const LIST_SECTIONS: readonly Gpt62Section[] = ["Code", "Limits"];

function activeGpt62Rules(toolNames: readonly string[], surface: PromptSurface): readonly Gpt62Rule[] {
	return GPT62_RULES.filter((rule: Gpt62Rule) => {
		const hasTool = rule.requiresTool === undefined || rule.requiresTool.some((name) => toolNames.includes(name));
		return hasTool && (rule.surfaces === undefined || rule.surfaces.includes(surface));
	});
}

function buildGpt62Core(context: DynamicPromptCoreContext): string {
	const rules = activeGpt62Rules(
		context.tools.map((tool) => tool.name),
		context.surface,
	);
	const sections = GPT62_SECTIONS.flatMap((section) => {
		const directives = rules.filter((rule) => rule.section === section).map((rule) => rule.directive);
		// A section whose rules are all bound to tools the session lacks renders nothing.
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

export function buildGpt62Prompt(options: BuildDynamicSystemPromptOptions): string {
	return buildDynamicSystemPrompt({ ...options, corePrompt: buildGpt62Core, workstationDialect: "codex" });
}
