import type { AgentToolResult } from "@mariozechner/pi-agent-core";

export function truncateOversizedToolResults(_results: AgentToolResult<unknown>[]): AgentToolResult<unknown>[] {
	return [];
}

export function prePruneToolOutputsToBudget(
	_results: AgentToolResult<unknown>[],
	_budget: number,
): AgentToolResult<unknown>[] {
	return [];
}
