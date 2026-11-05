import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** Raw JSON Schema, not the SDK v1 object-root subset. */
export type McpJsonSchema = boolean | Record<string, unknown>;
export type McpJsonValue = null | boolean | number | string | McpJsonValue[] | { [key: string]: McpJsonValue };
export type McpListedTool = Omit<Tool, "inputSchema" | "outputSchema"> & {
	readonly inputSchema: McpJsonSchema;
	readonly outputSchema?: McpJsonSchema;
};
export interface McpModernToolResult {
	readonly content?: Awaited<ReturnType<Client["callTool"]>>["content"];
	readonly structuredContent?: McpJsonValue;
	readonly isError?: boolean;
	readonly [key: string]: unknown;
}
export type McpToolResult = McpModernToolResult | Awaited<ReturnType<Client["callTool"]>>;
