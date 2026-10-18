import { resolveToolNameMatch } from "@earendil-works/pi-ai/utils/tool-name-match";
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
