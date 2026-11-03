import { getToolsPromptDisplay } from "./tool-categorization.ts";
import type { AvailableTool, PromptSurface, SharedSections } from "./types.ts";

function buildKeyTriggers(tools: AvailableTool[]): string {
	const triggerTools = getToolsPromptDisplay(tools);

	if (!triggerTools) {
		return "";
	}

	return `\nSpecialized search available this turn: ${triggerTools}. Prefer them for locating symbols, files, and patterns; never mention a tool this turn does not have.\n`;
}

export const DEFAULT_ROUTING_LINE_RULE = "Line keeps your reading transparent";
const FULL_ROUTING_LINE_RULE = "The line keeps your reading transparent";

const terminalRouting = (routingLineRule: string): string => `Open every turn with one short routing line:

I read this as [intent] - [plan]. I'll stop when [the observable condition that ends this turn].

${routingLineRule}; only user's explicit request commits you to implementation. Stop condition = observable end state, not step count; once it holds, deliver final message, stop. Never surface other prompt scaffolding to user.`;

const fullTerminalRouting = (routingLineRule: string): string => `Open every turn with one short routing line:

I read this as [intent] - [plan]. I'll stop when [the observable condition that ends this turn].

${routingLineRule}; only the user's explicit request commits you to implementation. Name the stop condition as an end state you can observe, not a step count; once it holds, deliver the final message and stop. Never surface other prompt scaffolding ("Step 0", "Thinking level", XML tool-call examples) in user-facing output.`;

const APP_ROUTING = `Only user's explicit request commits you to implementation. Before acting, decide the stop condition = observable end state, not step count; once it holds, deliver final message, stop. Never surface prompt scaffolding to user.`;

const FULL_APP_ROUTING = `Only the user's explicit request commits you to implementation. Before acting, decide the stop condition - an end state you can observe, not a step count; once it holds, deliver the final message and stop. Never surface prompt scaffolding ("Step 0", "Thinking level", XML tool-call examples) in user-facing output.`;

const ROUTE_RULES: Record<SharedSections, string> = {
	full: `Route by true intent, not surface form:
- Information asks (explain, look into, investigate): read the code, report the answer or findings - no edits, no fixes yet.
- Judgment asks (what do you think, review) and open-ended changes (refactor, improve, clean up): assess and propose, then wait for confirmation.
- Change asks (implement, add, fix this error): build, or diagnose and fix minimally, at exactly the asked scope - the smallest path that fully satisfies an open-ended goal; name an ambiguity and resolve it from context when possible.

Deliver the task at the scope asked - never quietly narrow, widen, or swap it. Make routine judgment calls yourself; ask only when different readings of the request would lead to materially different work.

Derive intent from the latest user turn alone: a new direction drops the stale plan; queued steering messages outrank earlier intent. Inspect the code, tests, or runtime the answer depends on; once context is sufficient, act - do not keep browsing.`,
	diet: `Route by true intent, not surface form:
- Information ask (explain, look into, investigate): read code, report answer/findings; no edits, no fixes yet.
- Judgment ask (what do you think, review) / open-ended change (refactor, improve, clean up): assess, propose, wait for confirmation.
- Change ask (implement, add, fix this error): build, or diagnose + minimal fix, exactly at asked scope = smallest path fully satisfying an open-ended goal; name ambiguity, resolve from context when possible.

Deliver at asked scope; never quietly narrow, widen, swap. Routine calls: decide yourself; ask only when readings diverge into materially different work.

Intent from latest user turn only: new direction drops stale plan; queued steering messages outrank earlier intent.`,
};

export function buildIntentGate(config: {
	tools: AvailableTool[];
	surface?: PromptSurface;
	/** Terminal-only: the clause before "only the user's explicit request commits you"; presets replace it. */
	routingLineRule?: string;
	sharedSections?: SharedSections;
}): string {
	const full = config.sharedSections === "full";
	const routing =
		(config.surface ?? "terminal") !== "terminal"
			? full
				? FULL_APP_ROUTING
				: APP_ROUTING
			: full
				? fullTerminalRouting(config.routingLineRule ?? FULL_ROUTING_LINE_RULE)
				: terminalRouting(config.routingLineRule ?? DEFAULT_ROUTING_LINE_RULE);
	return `## Intent Gate

${routing}
${buildKeyTriggers(config.tools)}
${ROUTE_RULES[config.sharedSections ?? "diet"]}`;
}
