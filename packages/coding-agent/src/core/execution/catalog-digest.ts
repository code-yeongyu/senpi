import type { AgentTool } from "@earendil-works/pi-agent-core";
import { digestOf, toStoreValue } from "./executor-freeze.ts";

/** The fields of a tool that decide what a call means: what the model is shown and how the executor runs it. */
export type CatalogTool = Pick<AgentTool, "name" | "description" | "parameters" | "outputSchema" | "executionMode">;

/**
 * The 32-byte SHA-256 digest (hex) of one tool's schema, in the executor's canonical JSON form (the form the model
 * and a hand receive). A call names the digest it was built against, so a change to this tool makes that call
 * stale while a change to any other tool does not.
 */
export function toolSchemaDigest(tool: CatalogTool): string {
	return digestOf(
		toStoreValue({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			outputSchema: tool.outputSchema,
			executionMode: tool.executionMode,
		}),
	);
}
