// GPT-6.2 Astra and GPT-6.2 Sol preset (senpi#6942). Both models share one prompting guide
// (developers.openai.com/api/docs/guides/latest-model, read 2026-11-17) and openai/codex ships one
// byte-identical instructions template for both (codex-rs/models-manager/models.json at 5916098d02),
// so one preset renders both. It is the tuned gpt-6-astra core (gpt-6-astra.ts) with five texts
// replaced at the sentence that owns each rule; every other sentence is shared, and the GPT-6, 6.1
// and older ids keep rendering gpt-6-astra byte for byte.
//
// What 6.2 changes, each against the existing rule that owns it:
// - Writing: codex replaced the 6-astra "Writing style" section that `## Writing` carried verbatim.
//   The 6.2 section keeps technical detail where it adds precision (the old text said to include it
//   only when it helps) and adds bans on invented terms and working shorthand, restated points,
//   self-announcing sentences, unsolicited recommendations and disclaimers, and prose semicolons and
//   explanatory colons. `## Writing` carries the 6.2 section verbatim except for two edits from the
//   contradiction audit below.
// - Final answer: OpenAI's launch post says both 6.2 models "were more likely to omit mentioning
//   obstacles that blocked their work, such as a missing file or unavailable search tool", and the
//   guide says working shorthand can leak into the final answer. Codex answers both in its "Final
//   answer" section. `final-message-shape` names obstacles and unguided decisions in the You need
//   slot and makes the final message self-contained, free of shorthand built while working.
// - Self-imposed requirements: codex 6.2 adds "Do not invent requirements, rules or policies that
//   block or delay work". `initiative-bias` owns scope, so it carries that sentence.
// - Earlier refusals: codex 6.2 adds "Do not let an earlier refusal or blocker ... decide how you
//   handle later requests". `unbounded-retry` owns what follows a failure, so it carries it.
// - Follow-ups and corrections: the guide says that with unclear intent 6.2 "may propose a next step
//   and wait for confirmation", and codex 6.2 adds that a follow-up, a challenge to the approach, or a
//   reported mistake asks for the work carried through. `steering` owns mid-task messages, so it
//   carries it.
//
// The guide's "more concise and direct by default; revisit instructions like 'be concise'" needs no
// edit: the core holds no generic brevity directive, and "Deliver the full artifact asked for" stays.
// The guide's append-only advice (the API drops reasoning items when the prefix is edited) is a
// transport concern owned by the catalog and the request builder, not the prompt.
//
// Contradiction audit of the composed prompt (every surface), each pair resolved at its source:
// - Codex 6.2's apology paragraph would repeat `no-reflexive-apology` in `## Reporting`; the Reporting
//   sentence stays and the Writing copy drops the paragraph.
// - The 6.2 colon rule ("Do not use colons to introduce explanations or examples, including after list
//   labels") collides with the handoff block, whose labels end in colons. The Writing copy keeps a reply
//   template's labels as written; it names no handoff block because the chat surface renders none.
// - "Do not provide unsolicited recommendations" against `no-unsolicited-caution` ("When the user's plan
//   is flawed, say once what breaks"): no conflict, the Initiative rule names the one case where the
//   model speaks up (a flaw in the plan it is executing) and forbids everything else, which is the
//   codex rule.
// - Codex's "Never ... state what something is not" against `final-message-shape` asking for what is
//   unverified and what blocked the work: no conflict, those are disclosures the user needs, which codex
//   itself requires in its Final answer section.
// - Codex's commentary-channel cadence, frontend fonts, coding-style list and permission section are
//   left out for the reasons gpt-6-astra.ts already records (no commentary channel; the Scope and
//   Recovery paragraph and `approval-last` own the same rules).

import type { BuildDynamicSystemPromptOptions } from "../../../dynamic-prompt/build.ts";
import { buildGpt6FamilyPrompt, GPT6_ASTRA_TEXT, type Gpt6CoreText } from "./gpt-6-astra.ts";

const NO_INVENTED_REQUIREMENTS =
	" Invent no requirement, rule, or policy that blocks, delays, or narrows the work: a precaution you chose, an example you followed, or a rule from an earlier task binds only when the user, an applicable policy, or a real technical dependency requires it, and one that gets in the way is corrected at its source.";

const CARRY_FOLLOW_UPS =
	"; a follow-up question, a challenge to your approach, or a mistake the user points out asks you to carry the work through and make the fix, unless the user asks only for an explanation or tells you to stop";
const STEERING_TAIL = "; drop the task only when the user cancels it or asks for something incompatible.";

const EARLIER_REFUSALS =
	" An earlier refusal or blocker does not decide a later request: before ruling an action out, asking again, or narrowing the work, name the permission rule or technical failure that still applies, and proceed once the user has clarified or approved or new evidence opens a permitted way.";

// openai/codex gpt-6.2-astra / gpt-6.2-sol instructions, "Writing style" section (5916098d02), verbatim
// except: the apology paragraph is left to `no-reflexive-apology`, the colon rule keeps a reply
// template's labels, and "X—not Y" is written "X - not Y" for the repo's no-em-dash copy lint.
const CODEX_62_WRITING_STYLE = [
	"Write as a user's colleague would: clear, professional, and using terminology the user and sources use. Keep technical details and use domain-specific language when they make the explanation more precise. Use the active voice and keep closely related details together. Give the user enough context to follow your reasoning.",
	"Do not invent jargon, new terms, or metaphors. Use established names or a short explanation instead. Do not invent shorthand naming, internal implementation labels, and unnecessary process narration.",
	"Do not repeat a previous point or insight with a declarative sentence, and never state a takeaway that the user is able to already infer. Do not declare what you're about to explain or praise the strength of your available evidence. Never announce that a finding or explanation is useful, compelling, or well supported. Don't use lead-in phrases or sentences that label a paragraph or announce your next point. Each sentence should progress the user's task. Do not use slogan-like summaries, and prefer concrete explanations instead.",
	'Do not provide unsolicited recommendations or invent concerns or misconceptions unless explicitly called for. Do not provide preemptive disclaimers, e.g. "this doesn\'t mean ..", "the key is...", "this is why I...".',
	'Never add what you won\'t do, state what something is not, what will remain unchanged, or how you\'ll separate or categorize results. Never use contrastive framing such as "X, not Y", "These are X, not Y", "I\'ll do X rather than Y", "it is about X, not about Y", and "X - not Y". Do not compare to an unsolicited alternative that the user did not directly ask about. Avoid invented compound labels like "exact-head checks" and "editorial-row layouts", vague qualifiers, and canned transitions. Carefully follow these instructions when writing in documents, slides or other artifacts as well.',
	"In prose, do not use semicolons. Do not use colons to introduce explanations or examples, including after list labels; a reply template this prompt gives keeps its labels as written. Avoid replacing colons directly with a period, instead rephrase the thought.",
	"Place source links at the end of each bullet or paragraph and keep explanatory text and prose free of inline links unless absolutely necessary.",
].join("\n\n");

const DISCLOSING_FINAL_MESSAGE =
	"The final message of a change is the handoff block and stands alone: the outcome first, then in its You need slot what a reader needs to trust it - the checks that ran, summarized, anything left unverified, every obstacle that blocked or narrowed the work (a missing file, an unavailable tool or source), the decisions you made without the user's guidance, and any pre-existing problem left in place - ordered so the conclusion is easiest to check. It reads without the earlier updates, in the user's terms, with none of the shorthand built up while working. Deliver the full artifact asked for; when something must shrink, cut repetition and background first.";

export const GPT62_TEXT: Gpt6CoreText = {
	initiativeBias: `${GPT6_ASTRA_TEXT.initiativeBias}${NO_INVENTED_REQUIREMENTS}`,
	steering: GPT6_ASTRA_TEXT.steering.replace(STEERING_TAIL, `${CARRY_FOLLOW_UPS}${STEERING_TAIL}`),
	unboundedRetry: `${GPT6_ASTRA_TEXT.unboundedRetry}${EARLIER_REFUSALS}`,
	writingStyle: CODEX_62_WRITING_STYLE,
	finalMessageShape: DISCLOSING_FINAL_MESSAGE,
};

export function buildGpt62Prompt(options: BuildDynamicSystemPromptOptions): string {
	return buildGpt6FamilyPrompt(options, GPT62_TEXT);
}
