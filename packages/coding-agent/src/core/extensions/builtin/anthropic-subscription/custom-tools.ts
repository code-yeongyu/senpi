import type { Tool } from "@earendil-works/pi-ai";
import { jsonSchemaToZodShape } from "./custom-tools-schema.ts";
import { getSdkBoundary, loadClaudeAgentSdk, type SdkBoundary } from "./sdk-boundary.ts";
import { CUSTOM_TOOLS_MCP_SERVER_NAME, TOOL_EXECUTION_DENIED_MESSAGE } from "./tools.ts";

type CustomToolsMcpServer = ReturnType<SdkBoundary["createSdkMcpServer"]>;

export async function denyCustomToolExecution() {
	return {
		content: [{ type: "text" as const, text: TOOL_EXECUTION_DENIED_MESSAGE }],
		isError: true,
	};
}

/**
 * Exposes senpi-only tools to Claude Code's planner. The SDK handler is deliberately
 * unusable: senpi receives the matching streamed tool call and executes it itself.
 */
export async function buildCustomToolServers(
	customTools: readonly Tool[],
): Promise<Record<string, CustomToolsMcpServer> | undefined> {
	if (customTools.length === 0) return undefined;
	// `createSdkMcpServer` is a synchronous SDK member behind a lazy boundary;
	// awaiting here is what makes this call site self-sufficient.
	await loadClaudeAgentSdk();
	const server = getSdkBoundary().createSdkMcpServer({
		name: CUSTOM_TOOLS_MCP_SERVER_NAME,
		version: "1.0.0",
		tools: customTools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: jsonSchemaToZodShape(tool.parameters),
			handler: denyCustomToolExecution,
		})),
	});
	return { [CUSTOM_TOOLS_MCP_SERVER_NAME]: server };
}
