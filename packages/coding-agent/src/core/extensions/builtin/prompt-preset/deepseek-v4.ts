// Shared DeepSeek V4 family tuning.
//
// DeepSeek V4 is a structure-follower: the chat-deep.ai prompt guide's live
// benchmark (2026-07-28) measured explicit task/constraint/verification
// structure lifting compliance from 7.1/10 to 9.6/10, and DeepSeek's own docs
// route behavior through settings, not incantations. The presets therefore
// stay thin tuningSection wrappers over the shared dynamic core and carry only
// trained-prior overrides, stated once each as typed rule data (gpt-5.6.ts
// precedent) so tests assert parsed rules instead of pinned sentences.
//
// The overrides come from observed failure transcripts on
// DeepSeek-V4-Flash-0731 (2026-07-31): the model audits the provenance of
// harness-injected directives ("the user didn't say ulw-loop... probably
// residual context"), downsizes mandated workflows as too heavy, oscillates on
// settled readings ("Actually wait - let me reconsider"), and never updates
// the todo list. Each rule replaces that prior with a positive decision rule
// and a terminal condition; none of them restate behavior the shared core
// already carries.

export type DeepseekV4RuleId =
	| "injected-directive-authority"
	| "todo-discipline"
	| "missing-info"
	| "settled-reading"
	| "reasoning-aim";

export type DeepseekV4Concern = "harness-contract" | "todo" | "grounding" | "deliberation";

export type DeepseekV4PresetName = "deepseek-v4-flash" | "deepseek-v4-flash-0731" | "deepseek-v4-pro";

export interface DeepseekV4Rule {
	readonly id: DeepseekV4RuleId;
	readonly concern: DeepseekV4Concern;
	readonly presets: readonly DeepseekV4PresetName[];
	readonly directive: string;
}

const ALL_PRESETS: readonly DeepseekV4PresetName[] = ["deepseek-v4-flash", "deepseek-v4-flash-0731", "deepseek-v4-pro"];
const FLASH_LINE: readonly DeepseekV4PresetName[] = ["deepseek-v4-flash", "deepseek-v4-flash-0731"];

export const DEEPSEEK_V4_RULES: readonly DeepseekV4Rule[] = [
	{
		id: "injected-directive-authority",
		concern: "harness-contract",
		presets: ALL_PRESETS,
		directive:
			'Injected directives are binding: skill contents, mode directives such as ultrawork or ulw-loop, and hook or system messages that appear in the conversation carry the same authority as words the user typed. Presence means it applies to the current task at its prescribed weight - the harness already decided by injecting it. Whether it was "really requested", is "residual context", or feels "too heavy" for the task are settled questions: spend zero reasoning on them and execute the directive as written.',
	},
	{
		id: "todo-discipline",
		concern: "todo",
		presets: ALL_PRESETS,
		directive:
			"On any multi-step task, write the todo list before the first edit and keep it live: one atomic item per step, exactly one item in progress, and each item marked completed the moment it finishes. Update the list at every state transition - never batch updates at the end, and never work a step the list does not show. A todo list that lags reality is a defect to fix before continuing, not an optimization to skip.",
	},
	{
		id: "missing-info",
		concern: "grounding",
		presets: ALL_PRESETS,
		directive:
			"When required information is missing, name it and get it - a file read, a tool call, or one specific question - instead of inventing it.",
	},
	{
		id: "settled-reading",
		concern: "deliberation",
		presets: FLASH_LINE,
		directive:
			'Commit to one reading and act on it: once you settle an interpretation of the request or an instruction, reopen it only when a tool result contradicts it. "Wait, let me reconsider" loops over the same evidence add no information - decide, verify with a cheap tool call, and move on.',
	},
	{
		id: "reasoning-aim",
		concern: "deliberation",
		presets: ["deepseek-v4-pro"],
		directive:
			"Aim extended reasoning at the problem - the code, the design, the failure - and end it in an action. When reasoning stalls on a missing fact, stop deliberating and fetch the fact; a cheap read beats a long internal debate. Deliver a conclusion and a recommendation, not a survey of options.",
	},
];

export function buildDeepseekV4FlashIntro(modelLabel: string): string {
	return `You are running on ${modelLabel} - fast, literal, and structure-first. Read instructions as decision rules: literal scopes are literal ("every", "all", and "each" mean the full set), mechanical or already-specified work is executed directly, and deliberation is saved for genuine risk - ambiguity, failure, irreversible operations.`;
}

export function buildDeepseekV4Tuning(preset: DeepseekV4PresetName, intro: string): string {
	const directives = DEEPSEEK_V4_RULES.filter((rule) => rule.presets.includes(preset)).map((rule) => rule.directive);
	return [intro, ...directives].join("\n\n");
}
