/**
 * The tool catalog a caller sees, in the form both placements must agree on: a hand (the loopless runtime)
 * and the fused engine expose the same declarations, in the same order, for the same configuration.
 */
import { normalizeToolExposure, type ToolDefinition } from "../../core/extensions/types.ts";
import type { ToolDefinitionEntry } from "../../core/runtime/bootstrap.ts";

type DeclaredTool = Pick<
	ToolDefinition,
	| "name"
	| "description"
	| "parameters"
	| "exposure"
	| "searchText"
	| "searchKeywords"
	| "searchGroup"
	| "allowLazyActivation"
>;

export interface ToolDeclaration extends ReturnType<typeof normalizeToolExposure> {
	readonly name: string;
	readonly description: string;
	readonly parameters: unknown;
}

export function toolCatalog(tools: Iterable<DeclaredTool>): readonly ToolDeclaration[] {
	return Array.from(tools, (tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		...normalizeToolExposure(tool),
	}));
}

export function handToolCatalog(definitions: ReadonlyMap<string, ToolDefinitionEntry>): readonly ToolDeclaration[] {
	return toolCatalog(Array.from(definitions.values(), (entry) => entry.definition));
}
