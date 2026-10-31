// Argon system prompt (senpi#3385).
//
// 2026-10-15. The provider's published guidance for the previous generation, which
// Argon continues (model docs: latest-model, prompting-strategies and "Agentic
// workflows", function-calling "Workarounds for pre-tool text", FAQ 8),
// says the model answers direct, concise instructions best and over-analyzes the
// shouting style older prompts used; structured text demanded right before a tool
// call can fail the call; the Pro line reaches for shell commands over custom
// tools; the newer releases run diagnostic code before changing anything. The
// default dynamic core already carries one home per rule, so this preset keeps
// every default section and changes four spots at their source (prompt-engineering
// A/B/C, no appended rule), plus the plain `gemini` workstation dialect:
// - identity names the model, as the Grok preset does (C: only the harness knows
//   which model is loaded).
// - Intent Gate (terminal): the routing line is plain prose and the tool calls that
//   start the work follow in the same response (B: the pre-tool-text warning and
//   the previous generation's "narrates instead of calling" failure the 2026-02-22 omo
//   overlays and oh-my-pi's reasoning-stall interrupt both guard against).
// - Working the Task opening, only when `eval` is a session tool: writing code is
//   the model's superpower, one eval cell per step with real control flow and
//   `parallel(thunks)`, one action at a time only for unseen-input, deploy,
//   approval and destructive calls (owner steer 2026-10-15; voice of the ultrawork
//   skill's "Parallel execution" section; Google: 10-20 active tools, parallel
//   calls when independent, code-first inspection).
// - Policies: transient failures retry as is, other failures change strategy and
//   never repeat the same call (B: the Agentic workflows template, rule 8.2).
// - `## Search Grounding`, only when `web_search` is a session tool (C: the
//   prompting-strategies "current day" clause; the date itself stays in the
//   environment-context message, senpi#2093).
// Byte-identical to the default everywhere else; prompt-presets-gemini-4-argon.test.ts
// checks that section by section.

import { APP_NAME } from "../../../../config.ts";
import {
	type BuildDynamicSystemPromptOptions,
	buildDynamicSystemPrompt,
	type DynamicPromptCoreContext,
} from "../../../dynamic-prompt/build.ts";
import { buildHandoffSection } from "../../../dynamic-prompt/handoff.ts";
import { buildIntentGate } from "../../../dynamic-prompt/intent-gate.ts";
import { buildPoliciesSection } from "../../../dynamic-prompt/policies.ts";
import { buildStyleSection } from "../../../dynamic-prompt/style.ts";
import { buildVerificationSection } from "../../../dynamic-prompt/verification.ts";
import { buildWorkingTaskSection } from "../../../dynamic-prompt/working-task.ts";

export const GEMINI_4_ARGON_ROUTING_LINE_RULE =
	"The line is plain prose, and the tool calls that start the work follow it in the same response";

export const GEMINI_4_ARGON_WORKING_TASK_OPENING = `Writing code is your superpower. A step is solved by writing one \`eval\` cell that does the work, not by a parade of one-off tool calls: every session tool is reachable from the cell as \`tool.<name>(...)\`, so the cell reads, searches, inspects, runs commands, and edits files with real control flow - a \`for\` over every target, an \`if\`/\`else\` per case, a \`try\`/\`catch\` per item - and fires every independent lookup AT ONCE through \`parallel(thunks)\`. Bias toward breadth when context is thin: pull in anything even loosely relevant in that wave instead of serially later, since wasted reads cost almost nothing and stale assumptions cost the turn. Reduce in the kernel to the facts the decision needs, keeping every failed or missing item verbatim; a result that hides a failure or a truncated tail is not evidence.

Sort the step before you write the cell: independent reads, searches, probes, and edits share one cell; a call whose input is a result you have not seen yet, a deploy, an approval, or a destructive command runs ONE ACTION AT A TIME, each observed before the next. Name the state a cell should produce before it runs and compare the return with that state. When the result must be SEEN rather than read - a page, an image, a layout - make one change, render it, look, then make the next. A direct tool call is the exception, for a single call that settles the step or an action that needs approval; files are read, searched, and edited through the cell's tool calls, never through shell text processing or inline scripts inside a command. Never fill missing parameters with placeholders.`;

export const GEMINI_4_ARGON_ERROR_RULE =
	'Never silently swallow errors. Retry a transient failure (timeout, rate limit, "try again") as is; on any other failure change the strategy or the arguments - never repeat the same failed call, and never shotgun-debug with unrelated edits.';

export const GEMINI_4_ARGON_SEARCH_GROUNDING = `## Search Grounding

Today's date is in the environment context and your training data ends before it: when a query is time-sensitive, form search queries from that date, and search before answering about anything "latest"; facts that cannot change need no search.`;

function hasTool(context: DynamicPromptCoreContext, name: string): boolean {
	return context.tools.some((tool) => tool.name === name);
}

function buildGemini4ArgonCore(context: DynamicPromptCoreContext): string {
	const appName = context.appName ?? APP_NAME;
	return [
		`You are ${appName}, a coding agent running on Gemini 4 Argon. Your work should be indistinguishable from a careful senior engineer's.`,
		"",
		buildIntentGate({
			tools: context.tools,
			surface: context.surface,
			routingLineRule: GEMINI_4_ARGON_ROUTING_LINE_RULE,
		}),
		"",
		buildWorkingTaskSection(hasTool(context, "eval") ? { opening: GEMINI_4_ARGON_WORKING_TASK_OPENING } : {}),
		"",
		buildVerificationSection({ surface: context.surface }),
		"",
		context.toolSection,
		"",
		buildPoliciesSection({ errorRule: GEMINI_4_ARGON_ERROR_RULE }),
		"",
		buildHandoffSection({ surface: context.surface }),
		"",
		buildStyleSection({ surface: context.surface }),
	].join("\n");
}

export function buildGemini4ArgonPrompt(options: BuildDynamicSystemPromptOptions): string {
	return buildDynamicSystemPrompt({
		...options,
		corePrompt: buildGemini4ArgonCore,
		...(options.selectedTools.includes("web_search") ? { tuningSection: GEMINI_4_ARGON_SEARCH_GROUNDING } : {}),
		workstationDialect: "gemini",
	});
}
