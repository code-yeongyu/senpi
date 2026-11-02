/**
 * The tool catalog a caller sees, in the form both placements must agree on: a hand (the loopless runtime)
 * and the fused engine expose the same declarations, in the same order, for the same configuration. It holds
 * every field that reaches the model (the declaration, the system-prompt snippet and guidelines), the UI
 * (label) or another client (`getAllTools`: namespace, annotations, the projected kernel prelude). A tool's
 * `permissionParser` is code, not data, and is compared by the tool that owns it.
 */
import { projectKernelPrelude } from "../../core/extensions/kernel-prelude.ts";
import { normalizeToolExposure, type ToolDefinition } from "../../core/extensions/types.ts";
import type { ToolDefinitionEntry } from "../../core/runtime/bootstrap.ts";

type DeclaredTool = Pick<
	ToolDefinition,
	| "name"
	| "label"
	| "description"
	| "parameters"
	| "promptSnippet"
	| "promptGuidelines"
	| "kernelPrelude"
	| "namespace"
	| "annotations"
	| "exposure"
	| "searchText"
	| "searchKeywords"
	| "searchGroup"
	| "allowLazyActivation"
>;

export interface ToolDeclaration extends ReturnType<typeof normalizeToolExposure> {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: unknown;
	readonly promptSnippet: string | undefined;
	readonly promptGuidelines: readonly string[] | undefined;
	readonly kernelPrelude: ReturnType<typeof projectKernelPrelude>;
	readonly namespace: DeclaredTool["namespace"];
	readonly annotations: DeclaredTool["annotations"];
}

export function toolCatalog(tools: Iterable<DeclaredTool>): readonly ToolDeclaration[] {
	return Array.from(tools, (tool) => ({
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		promptSnippet: tool.promptSnippet,
		promptGuidelines: tool.promptGuidelines,
		kernelPrelude: projectKernelPrelude(tool.name, tool.kernelPrelude),
		namespace: tool.namespace,
		annotations: tool.annotations,
		...normalizeToolExposure(tool),
	}));
}

export function handToolCatalog(definitions: ReadonlyMap<string, ToolDefinitionEntry>): readonly ToolDeclaration[] {
	return toolCatalog(Array.from(definitions.values(), (entry) => entry.definition));
}
