import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type {
	CallToolResult,
	GetPromptResult,
	ListPromptsResult,
	ListResourcesResult,
	ListToolsResult,
	ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
	CallToolRequestSchema,
	GetPromptRequestSchema,
	ListPromptsRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { FixtureOptions } from "./options.ts";

interface JsonSchemaObject {
	type: "object";
	properties?: Record<string, object>;
	required?: string[];
	[key: string]: unknown;
}

interface FixtureTool {
	name: string;
	description: string;
	inputSchema: JsonSchemaObject;
}

export function createFixtureServer(options: FixtureOptions): Server {
	const server = new Server(
		{ name: "senpi-mcp-fixture", version: "0.0.0" },
		{
			capabilities: {
				tools: { listChanged: options.emitListChanged },
				resources: { subscribe: true, listChanged: true },
				prompts: { listChanged: true },
				logging: {},
			},
			instructions: options.instructions,
		},
	);
	const tools = buildTools(options);
	let calls = 0;

	server.setRequestHandler(ListToolsRequestSchema, (): ListToolsResult => ({ tools }));
	server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
		calls++;
		const result = await callFixtureTool(request.params.name, request.params.arguments ?? {}, options);
		if (options.emitListChanged) {
			await server.sendToolListChanged();
		}
		if (options.crashAfterCalls !== null && calls >= options.crashAfterCalls) {
			setTimeout(() => process.exit(42), 20).unref();
		}
		return result;
	});
	server.setRequestHandler(
		ListResourcesRequestSchema,
		(): ListResourcesResult => ({
			resources: [{ uri: "fixture://resource/one", name: "fixture-resource", mimeType: "text/plain" }],
		}),
	);
	server.setRequestHandler(
		ReadResourceRequestSchema,
		(request): ReadResourceResult => ({
			contents: [
				{ uri: request.params.uri, mimeType: "text/plain", text: `resource body for ${request.params.uri}` },
			],
		}),
	);
	server.setRequestHandler(
		ListPromptsRequestSchema,
		(): ListPromptsResult => ({
			prompts: [
				{
					name: "fixture_prompt",
					description: "Fixture prompt with one argument",
					arguments: [{ name: "name", required: true, description: "Name to include" }],
				},
			],
		}),
	);
	server.setRequestHandler(
		GetPromptRequestSchema,
		(request): GetPromptResult => ({
			messages: [
				{
					role: "user",
					content: { type: "text", text: `Hello ${request.params.arguments?.name ?? "fixture"}` },
				},
			],
		}),
	);
	return server;
}

function buildTools(options: FixtureOptions): FixtureTool[] {
	const tools: FixtureTool[] = [];
	for (let index = 1; index <= options.toolCount; index++) {
		tools.push({
			name: `tool_${index}`,
			description: `Generated fixture tool ${index}`,
			inputSchema: richInputSchema(),
		});
	}
	if (options.isErrorTool) {
		tools.push({ name: "iserror_tool", description: "Always returns isError", inputSchema: emptyInputSchema() });
	}
	if (options.hugeOutput) {
		tools.push({
			name: "huge_output_tool",
			description: "Returns deterministic huge output",
			inputSchema: emptyInputSchema(),
		});
	}
	return tools;
}

function richInputSchema(): JsonSchemaObject {
	return {
		type: "object",
		properties: {
			value: { type: "string", format: "uri-reference", description: "Echo value" },
			mode: { type: "string", enum: ["alpha", "beta"], description: "Fixture enum" },
			nested: {
				oneOf: [
					{ type: "object", properties: { count: { type: "integer", minimum: 0 } }, required: ["count"] },
					{ type: "object", properties: { flag: { type: "boolean" } }, required: ["flag"] },
				],
			},
		},
		required: [],
	};
}

function emptyInputSchema(): JsonSchemaObject {
	return { type: "object", properties: {}, required: [] };
}

async function callFixtureTool(
	name: string,
	args: Record<string, unknown>,
	options: FixtureOptions,
): Promise<CallToolResult> {
	if (name === "iserror_tool") {
		return { isError: true, content: [{ type: "text", text: "fixture isError result" }] };
	}
	if (name === "huge_output_tool" && options.hugeOutput) {
		return { content: [{ type: "text", text: hugeOutput(options.hugeOutput.bytes, options.hugeOutput.lines) }] };
	}
	if (!name.startsWith("tool_")) {
		return { isError: true, content: [{ type: "text", text: `unknown fixture tool: ${name}` }] };
	}
	return {
		content: [
			{
				type: "text",
				text: `fixture ${name} value=${stringArg(args.value, "ok")} mode=${stringArg(args.mode, "alpha")}`,
			},
		],
	};
}

function stringArg(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function hugeOutput(bytes: number, lines: number): string {
	const lineCount = Math.max(1, lines);
	const line = "x".repeat(Math.max(1, Math.floor(bytes / lineCount)));
	return Array.from({ length: lineCount }, () => line)
		.join("\n")
		.slice(0, bytes);
}
