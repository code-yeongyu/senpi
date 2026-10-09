import type { PromptSurface, TerminalOrApp } from "./types.ts";

export interface HandoffSectionOptions {
	/**
	 * The caller's core already states a text-only turn-end rule ("check your last paragraph"),
	 * so the block drops its own "a Next with nothing after it is a defect" clause instead of
	 * stating that rule twice.
	 */
	turnEndRuleStatedElsewhere?: boolean;
	/**
	 * The model under-reports during long tool chains by default (Claude Fable 5.1 guide, "Ask for
	 * user-facing progress updates": remove narration-suppressing lines, then say when user-facing
	 * text is wanted and what each update contains), so the quiet-between-handoffs sentence becomes a
	 * brief-update instruction naming the moment and the shape. Rendered only by the Claude Fable 5.1
	 * preset (senpi#2681).
	 */
	briefUpdatesBetweenHandoffs?: boolean;
	/** The app surface has no routing line, so the block stops referring to one; chat has no block at all. */
	surface?: PromptSurface;
}

/**
 * The handoff and routing-line templates are English sentences that Claude copies verbatim, which pulls
 * the whole reply into English (senpi#2366). The labels stay fixed because the ttsr repetitive-turns
 * detector parses `Ask:` through `For you:` / `Now:` in model output; everything filled in follows the user.
 */
export const HANDOFF_LANGUAGE_RULE =
	"Keep the labels Ask, wanted, For you, Now, and Next exactly as written; write everything else - the routing line, slot contents, todo labels, and the reply itself - in the user's language (the one their instructions name, else the one they write in), with Now and Next repeating the todo labels verbatim.";

const APP_HANDOFF_LANGUAGE_RULE = HANDOFF_LANGUAGE_RULE.replace("the routing line, ", "");

const HANDOFF_MOMENTS: Record<TerminalOrApp, string> = {
	terminal:
		"A handoff is the todo list's creation (in the message that creates it, after the routing line, or the next one), each todo phase change, a blocker or plan change, and the final message of a turn that did work; the routing line is not one, and a reply that only answers a question is the answer itself.",
	app: "A handoff is the todo list's creation (in the message that creates it or the next one), each todo phase change, a blocker or plan change, and the final message of a turn that did work; a reply that only answers a question is the answer itself.",
};

/**
 * On `chat` each reply is posted to the people in a conversation (senpi#2398): the reply is the answer,
 * with no handoff block or ledger for a chat room to read. Shared by every core that states handoffs.
 */
export const CHAT_REPLY_RULE =
	"Each reply is posted as a chat message to the people in the conversation. Write the answer itself in their language, with no status block, todo labels, or progress ledger; the plan and its progress live in the todo tool only.";

export const CHAT_REPLIES_SECTION = `## Replies\n\n${CHAT_REPLY_RULE}`;

/** Opens a core's final-message rule on `chat`, in place of "The final message opens with the Handoff block". */
export const CHAT_FINAL_MESSAGE = "The final message is the answer itself";

export function buildHandoffSection(options: HandoffSectionOptions = {}): string {
	const surface = options.surface ?? "terminal";
	if (surface === "chat") return CHAT_REPLIES_SECTION;
	const nextRule = options.turnEndRuleStatedElsewhere
		? "The Next you name is executed in this same response with tool calls."
		: "The Next you name is executed in this same response with tool calls; a Next with nothing after it is a defect.";
	const betweenRule = options.briefUpdatesBetweenHandoffs
		? "Between handoffs, after each tool wave that changes what you know, write one line of reply text: what you found, then `Now: [task]. Next: [task].`"
		: "Between handoffs, work without narration.";
	const languageRule = surface === "app" ? APP_HANDOFF_LANGUAGE_RULE : HANDOFF_LANGUAGE_RULE;
	return `## Handoff

${HANDOFF_MOMENTS[surface]} Before writing one, weigh what the user originally asked for and what they would want to know right now; then state it in one short block:

Ask: [the user's original request] - wanted: [the outcome they asked for]. For you: [what they need to know now - ledger N/M done, findings, blockers]. Now: [the todo task in progress]. Next: [the next open task].

${languageRule} ${nextRule} ${betweenRule}`;
}
