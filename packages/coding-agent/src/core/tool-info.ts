import { projectKernelPrelude } from "./extensions/kernel-prelude.ts";
import { normalizeToolExposure, type ToolInfo } from "./extensions/types.ts";
import type { ToolDefinitionEntry } from "./runtime/bootstrap.ts";

/**
 * What `pi.getAllTools()` reports for a registry: every tool projected, and those the armed eval-only routing
 * withholds from the model marked `evalOnly`. A session and a loopless runtime project it the same way.
 */
export function toolInfosOf(
	definitions: ReadonlyMap<string, ToolDefinitionEntry>,
	evalOnly: ReadonlySet<string>,
): ToolInfo[] {
	return Array.from(definitions.values(), (entry) => {
		const info = toolInfoOf(entry);
		return evalOnly.has(info.name) ? { ...info, evalOnly: true } : info;
	});
}

function toolInfoOf({ definition, sourceInfo }: ToolDefinitionEntry): ToolInfo {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		promptGuidelines: definition.promptGuidelines,
		kernelPrelude: projectKernelPrelude(definition.name, definition.kernelPrelude),
		permissionParser: definition.permissionParser,
		...(definition.namespace ? { namespace: definition.namespace } : {}),
		...(definition.annotations ? { annotations: { ...definition.annotations } } : {}),
		sourceInfo,
		...normalizeToolExposure(definition),
	};
}
