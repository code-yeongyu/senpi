import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { isModernMcpClient } from "./modern/request.ts";
import { callModernTool, listModernTools } from "./modern/tools.ts";
import type { McpJsonSchema, McpListedTool, McpToolResult } from "./tool-contracts.ts";

/**
 * Tool operations have an era-specific contract. The SDK client remains the
 * lifecycle/request owner, but its legacy tool helpers never parse modern data.
 */
export async function listMcpTools(
	client: Client,
	params?: Parameters<Client["listTools"]>[0],
	options?: RequestOptions,
): Promise<{ tools: McpListedTool[]; nextCursor?: string }> {
	if (!isModernMcpClient(client)) return client.listTools(params, options);
	return listModernTools(client, params, options);
}

export async function callMcpToolRequest(
	client: Client,
	params: Parameters<Client["callTool"]>[0],
	outputSchema: McpJsonSchema | undefined,
	options?: RequestOptions,
): Promise<McpToolResult> {
	if (!isModernMcpClient(client)) return client.callTool(params, undefined, options);
	return callModernTool(client, params, outputSchema, options);
}
