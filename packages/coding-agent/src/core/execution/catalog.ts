import { type CatalogTool, toolSchemaDigest } from "./catalog-digest.ts";

export interface ToolCatalogEntry {
	readonly name: string;
	readonly description: string;
	readonly parameters: CatalogTool["parameters"];
	readonly outputSchema?: CatalogTool["outputSchema"];
	readonly executionMode?: CatalogTool["executionMode"];
	/** Hex SHA-256 of this tool's schema (`toolSchemaDigest`). */
	readonly schemaDigest: string;
}

export type ToolCatalog = ReadonlyMap<string, ToolCatalogEntry>;

export interface CatalogCall {
	readonly name: string;
	readonly schemaDigest: string;
}

export type CatalogCallCheck =
	| { readonly ok: true; readonly entry: ToolCatalogEntry }
	| { readonly ok: false; readonly reason: "tool_unknown" | "schema_stale"; readonly name: string };

export function buildToolCatalog(tools: Iterable<CatalogTool>): ToolCatalog {
	const catalog = new Map<string, ToolCatalogEntry>();
	for (const tool of tools) {
		catalog.set(tool.name, {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
			...(tool.executionMode === undefined ? {} : { executionMode: tool.executionMode }),
			schemaDigest: toolSchemaDigest(tool),
		});
	}
	return catalog;
}

/**
 * Decides, before any effect, whether a call may run against this catalog. Staleness is per tool: a call
 * is refused only when its own tool is gone (`tool_unknown`) or its own schema changed (`schema_stale`).
 */
export function checkCatalogCall(catalog: ToolCatalog, call: CatalogCall): CatalogCallCheck {
	const entry = catalog.get(call.name);
	if (entry === undefined) return { ok: false, reason: "tool_unknown", name: call.name };
	if (entry.schemaDigest !== call.schemaDigest) return { ok: false, reason: "schema_stale", name: call.name };
	return { ok: true, entry };
}
