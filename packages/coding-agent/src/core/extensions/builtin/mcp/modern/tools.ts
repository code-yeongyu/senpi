import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { z } from "zod";
import { loadMcpSdkTypes } from "../sdk.lazy.ts";
import type { McpJsonSchema } from "../tool-contracts.ts";
import { McpMrtrError } from "./errors.ts";
import { compileModernSchema, hasSupportedModernToolSchemas, McpToolSchemaError } from "./tool-schema.ts";

const jsonSchema = z.union([z.boolean(), z.record(z.string(), z.json())]);
const modernToolSchema = z.looseObject({
	name: z.string(),
	inputSchema: jsonSchema,
	outputSchema: jsonSchema.optional(),
});
const listResult = z.looseObject({
	tools: z.array(modernToolSchema),
	nextCursor: z.string().optional(),
});
const callResult = z.looseObject({
	isError: z.boolean().optional(),
	structuredContent: z.json().optional(),
});

export async function listModernTools(
	client: Client,
	params?: Parameters<Client["listTools"]>[0],
	options?: RequestOptions,
) {
	// Keep the SDK behind its documented startup boundary, and its Zod identity separate.
	const { ResultSchema, ToolSchema } = await loadMcpSdkTypes();
	const toolMetadata = ToolSchema.omit({ inputSchema: true, outputSchema: true });
	const raw = await client.request({ method: "tools/list", params }, ResultSchema, options);
	const parsed = listResult.safeParse(raw);
	if (!parsed.success) throw new McpMrtrError("MCP_MRTR_INVALID_RESULT");
	const tools = parsed.data.tools.filter(hasSupportedModernToolSchemas).map((tool) => {
		const metadata = toolMetadata.safeParse(tool);
		if (!metadata.success) throw new McpMrtrError("MCP_MRTR_INVALID_RESULT");
		return { ...tool, ...metadata.data };
	});
	return { ...parsed.data, tools };
}

export async function callModernTool(
	client: Client,
	params: Parameters<Client["callTool"]>[0],
	outputSchema: McpJsonSchema | undefined,
	options?: RequestOptions,
) {
	const { CallToolResultSchema, ResultSchema } = await loadMcpSdkTypes();
	const validate = outputSchema === undefined ? undefined : compileModernSchema(outputSchema);
	const raw = await client.request({ method: "tools/call", params }, ResultSchema, options);
	const parsed = callResult.safeParse(raw);
	if (!parsed.success) throw new McpMrtrError("MCP_MRTR_INVALID_RESULT");
	const content = CallToolResultSchema.shape.content.optional().safeParse(raw.content);
	if (!content.success) throw new McpMrtrError("MCP_MRTR_INVALID_RESULT");
	const result = { ...parsed.data, ...(content.data === undefined ? {} : { content: content.data }) };
	if (validate !== undefined && result.isError !== true) {
		if (!Object.hasOwn(result, "structuredContent") || !validate(result.structuredContent)) {
			throw new McpToolSchemaError("MCP_OUTPUT_SCHEMA_MISMATCH", "Tool result does not match outputSchema.");
		}
	}
	return result;
}
