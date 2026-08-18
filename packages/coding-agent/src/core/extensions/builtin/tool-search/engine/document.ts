export type ToolSearchSource = "mcp" | "extension";

export interface ToolSearchDocument {
	readonly name: string;
	readonly label: string;
	readonly aliases: readonly string[];
	readonly description?: string;
	readonly searchText?: string;
	readonly keywords: readonly string[];
	readonly source: ToolSearchSource;
	readonly group: string;
	readonly ownerLabel: string;
	readonly registrationId: string;
}
