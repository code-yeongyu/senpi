import { getToolsPromptDisplay } from "./tool-categorization.ts";
import type { AvailableTool, PromptSurface } from "./types.ts";

function buildKeyTriggers(tools: AvailableTool[]): string {
	const triggerTools = getToolsPromptDisplay(tools);

	if (!triggerTools) {
		return "";
	}

	return `\nSpecialized search available this turn: ${triggerTools}. Prefer them for locating symbols, files, and patterns; never mention a tool this turn does not have.\n`;
}

export const DEFAULT_ROUTING_LINE_RULE = "Line keeps your reading transparent";

const terminalRouting = (routingLineRule: string): string => `Open every turn with one short routing line:

I read this as [intent] - [plan]. I'll stop when [the observable condition that ends this turn].

${routingLineRule}; only user's explicit request commits you to implementation. Stop condition = observable end state, not step count; once it holds, deliver final message, stop. Never surface other prompt scaffolding to user.`;

const APP_ROUTING = `Only user's explicit request commits you to implementation. Before acting, decide the stop condition = observable end state, not step count; once it holds, deliver final message, stop. Never surface prompt scaffolding to user.`;

export function buildIntentGate(config: {
	tools: AvailableTool[];
	surface?: PromptSurface;
	/** Terminal-only: the clause before "only the user's explicit request commits you"; presets replace it. */
	routingLineRule?: string;
}): string {
	return `## Intent Gate

${(config.surface ?? "terminal") === "terminal" ? terminalRouting(config.routingLineRule ?? DEFAULT_ROUTING_LINE_RULE) : APP_ROUTING}
${buildKeyTriggers(config.tools)}
Route by true intent, not surface form:
- Information ask (explain, look into, investigate): read code, report answer/findings; no edits, no fixes yet.
- Judgment ask (what do you think, review) / open-ended change (refactor, improve, clean up): assess, propose, wait for confirmation.
- Change ask (implement, add, fix this error): build, or diagnose + minimal fix, exactly at asked scope = smallest path fully satisfying an open-ended goal; name ambiguity, resolve from context when possible.

Deliver at asked scope; never quietly narrow, widen, swap. Routine calls: decide yourself; ask only when readings diverge into materially different work.

Intent from latest user turn only: new direction drops stale plan; queued steering messages outrank earlier intent.`;
}
