import type { ExtensionAPI, ToolDefinition } from "./core/extensions/types.ts";

/** Public callable names supplied by the opening host, encoded as a comma-separated session label. */
export const HOST_TOOL_NAMES_CONTEXT_KEY = "host_tool_names";

/**
 * Attach host implementations through the SDK without adding them to the engine catalog.
 * A standalone fallback yields to names the opening host supplies, before either implementation runs.
 */
export function attachHostTools(
	api: Pick<ExtensionAPI, "registerTool" | "sessionContext">,
	tools: readonly ToolDefinition[],
	options: { readonly fallback?: boolean } = {},
): void {
	const supplied = new Set(
		(api.sessionContext[HOST_TOOL_NAMES_CONTEXT_KEY] ?? "")
			.split(",")
			.map((name) => name.trim())
			.filter(Boolean),
	);
	for (const tool of tools) {
		if (options.fallback && supplied.has(tool.name)) continue;
		api.registerTool(tool);
	}
}
