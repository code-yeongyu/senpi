export interface AvailableTool {
	name: string;
	category: "lsp" | "ast" | "search" | "session" | "command" | "other";
}
