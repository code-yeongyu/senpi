import type { TSchema } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "../../types.ts";

export function registerToolsPreservingActiveSet<TParams extends TSchema, TDetails, TState>(
	pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "registerTool">,
	tools: readonly ToolDefinition<TParams, TDetails, TState>[],
	intendedActiveTools: readonly string[] = pi.getActiveTools(),
): void {
	const intendedSet = [...intendedActiveTools];
	for (const tool of [...tools].sort((left, right) => left.name.localeCompare(right.name))) {
		pi.registerTool(tool);
	}
	pi.setActiveTools(intendedSet);
}
