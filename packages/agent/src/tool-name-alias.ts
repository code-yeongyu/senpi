import { foldToolName, resolveToolNameMatch, toolNameForms } from "@earendil-works/pi-ai/utils/tool-name-match";
import type { AgentContext, AgentLoopConfig, AgentTool, AgentToolCall, AgentToolResult } from "./types.ts";

/**
 * A model can call a tool by a name it was never registered under: recased,
 * under a gateway namespace (`mcp__<id>__<Name>`, any case), or without the
 * namespace a registered tool carries. The shared matcher resolves such a name
 * only when exactly one available tool matches; it never guesses.
 */
export function resolveToolNameAlias(requested: string, available: Iterable<string>): string | undefined {
	return resolveToolNameMatch(requested, available);
}

export function toolNameCorrectionNotice(requested: string, resolved: string): string {
	return `[auto-corrected] no tool is named "${requested}"; ran "${resolved}". Call tools by their exact listed name.`;
}

/**
 * Registered tools whose names are closest to `requested`, nearest first.
 *
 * Folds through the same shapes the alias matcher accepts (case and separator
 * folds, gateway and server namespaces, registered names that carry a prefix
 * the call dropped), so a typo, recasing, singular/plural drift, or prefix
 * drift still lands next to the right tool. The edit budget is a third of the
 * folded candidate's length: at least one edit, at most three, so an unrelated
 * name suggests nothing — a wrong suggestion costs more than the bare error.
 */
export function suggestToolNames(requested: string, available: Iterable<string>, limit = 3): string[] {
	const forms = toolNameForms(requested).map((form) => foldToolName(form));
	const scored: { name: string; distance: number }[] = [];
	for (const name of new Set(available)) {
		const folded = foldToolName(name);
		const budget = Math.max(1, Math.min(3, Math.floor(folded.length / 3)));
		const distance = closestFoldDistance(
			forms,
			toolNameForms(name).map((form) => foldToolName(form)),
		);
		if (distance > budget) continue;
		scored.push({ name, distance });
	}
	return scored
		.sort((left, right) => left.distance - right.distance || (left.name < right.name ? -1 : 1))
		.slice(0, limit)
		.map((entry) => entry.name);
}

/**
 * The `Did you mean ...?` clause for a call to a name no tool carries, or
 * `undefined` when no registered name is close enough.
 */
export function unknownToolSuggestion(requested: string, available: Iterable<string>): string | undefined {
	const suggestions = suggestToolNames(requested, available);
	if (suggestions.length === 0) return undefined;
	return `Did you mean ${suggestions.join(", ")}?`;
}

/**
 * The error text for a call no tool carries: bare when nothing is close, with
 * the nearest registered names otherwise, so one turn repairs a typo instead
 * of the model re-listing tools.
 */
export function unknownToolErrorText(requested: string, available: Iterable<string>): string {
	const suggestion = unknownToolSuggestion(requested, available);
	return suggestion === undefined ? `Tool ${requested} not found` : `Tool ${requested} not found. ${suggestion}`;
}

function closestFoldDistance(forms: string[], registeredForms: string[]): number {
	let closest = Number.POSITIVE_INFINITY;
	for (const form of forms) {
		for (const registered of registeredForms) {
			closest = Math.min(closest, editDistance(form, registered));
			if (closest === 0) return 0;
		}
	}
	return closest;
}

/** Levenshtein distance over folded names; the caller's budget gates how far a suggestion may reach. */
function editDistance(left: string, right: string): number {
	let previous = new Uint16Array(right.length + 1);
	for (let column = 0; column <= right.length; column += 1) previous[column] = column;
	for (let row = 1; row <= left.length; row += 1) {
		const current = new Uint16Array(right.length + 1);
		current[0] = row;
		for (let column = 1; column <= right.length; column += 1) {
			const substitution = previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1);
			current[column] = Math.min(current[column - 1] + 1, previous[column] + 1, substitution);
		}
		previous = current;
	}
	return previous[right.length];
}

/**
 * Find the tool a call will run, resolving an unknown name through the host
 * resolver and then the alias rule. Runs before `tool_execution_start` so every
 * event names the tool that executes, never the name the model mistyped.
 */
export async function resolveCallTool(
	currentContext: AgentContext,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
): Promise<AgentTool | undefined> {
	if (toolCall.incomplete === true) return undefined;
	const exact = currentContext.tools?.find((candidate) => candidate.name === toolCall.name);
	if (exact) return exact;
	const resolved = await config.resolveUnknownToolCall?.(toolCall.name, currentContext);
	if (resolved) return resolved;
	const aliasedName = resolveToolNameAlias(
		toolCall.name,
		(currentContext.tools ?? []).map((candidate) => candidate.name),
	);
	return currentContext.tools?.find((candidate) => candidate.name === aliasedName);
}

export function withToolNameCorrection(
	result: AgentToolResult<unknown>,
	requestedName: string,
	resolvedName: string,
): AgentToolResult<unknown> {
	return {
		...result,
		// Model-only: it steers the model back to exact names; the user sees the resolved tool as if called directly.
		content: [
			{ type: "text", text: toolNameCorrectionNotice(requestedName, resolvedName), audience: "model" },
			...(result.content ?? []),
		],
	};
}
