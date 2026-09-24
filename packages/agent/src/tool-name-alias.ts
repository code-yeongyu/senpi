import type { AgentContext, AgentLoopConfig, AgentTool, AgentToolCall, AgentToolResult } from "./types.ts";

/**
 * Some provider wire paths show the model non-native tools as
 * `mcp__<id>__<Name>` (recased, under a namespace senpi never defined), and a
 * model can carry that shape into a call for a tool it learned by its bare
 * name. Resolve such a call only when exactly one available tool matches after
 * stripping the namespace and folding case and `-`/`_` separators; never guess
 * between two candidates.
 */
const GATEWAY_TOOL_NAMESPACE = /^mcp__[^_]+__(.+)$/;

function foldToolName(name: string): string {
	return name.toLowerCase().replaceAll(/[-_]/g, "");
}

export function resolveToolNameAlias(requested: string, available: Iterable<string>): string | undefined {
	const names = [...new Set(available)];
	if (names.includes(requested)) return requested;
	const unnamespaced = GATEWAY_TOOL_NAMESPACE.exec(requested)?.[1] ?? requested;
	if (names.includes(unnamespaced)) return unnamespaced;
	const key = foldToolName(unnamespaced);
	const matches = names.filter((name) => foldToolName(name) === key);
	return matches.length === 1 ? matches[0] : undefined;
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
