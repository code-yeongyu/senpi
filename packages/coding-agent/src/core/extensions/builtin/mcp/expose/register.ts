import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { Progress } from "@modelcontextprotocol/sdk/types.js";
import type { TSchema } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "../../../types.ts";
import { registerToolsPreservingActiveSet } from "../active-set.ts";
import type { McpToolCatalogEntry } from "../catalog.ts";
import { ToolExecError } from "../errors.ts";
import { ensureMcpToolCallConnection } from "../health.ts";
import {
	buildMcpToolNames,
	convertJsonSchemaToTypeBox,
	type McpContentBlock,
	type McpMappedContentBlock,
	type McpToolResultLike,
	mapMcpToolResult,
} from "./schema-compat.ts";

export interface McpToolDetails {
	server: string;
	tool: string;
	preview?: string;
	progress?: Progress;
}

type McpAgentContent = TextContent | ImageContent;
type McpToolDefinition = ToolDefinition<TSchema, McpToolDetails | undefined, unknown>;
type WarnFn = (message: string) => void;

export function registerMcpCatalogTools(
	pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "registerTool">,
	entries: readonly McpToolCatalogEntry[],
	activeEntries: readonly McpToolCatalogEntry[],
	warn?: WarnFn,
): void {
	const tools = buildMcpToolDefinitions(entries, warn);
	const currentActive = pi.getActiveTools().filter((name) => !name.startsWith("mcp_"));
	const mcpNames = buildActiveToolNames(entries, activeEntries, warn);
	registerToolsPreservingActiveSet(pi, tools, [...currentActive, ...mcpNames]);
}

export function buildMcpToolDefinitions(entries: readonly McpToolCatalogEntry[], warn?: WarnFn): McpToolDefinition[] {
	const sorted = [...entries].sort(compareCatalogEntries);
	const names = buildMcpToolNames(
		sorted.map((entry) => ({ serverName: entry.server, toolName: entry.tool })),
		warn,
	);
	return sorted.map((entry, index) => createMcpToolDefinition(entry, names[index] ?? ""));
}

function createMcpToolDefinition(entry: McpToolCatalogEntry, name: string): McpToolDefinition {
	const converted = convertJsonSchemaToTypeBox(entry.schema);
	const label = `${entry.server}/${entry.tool}`;
	return {
		name,
		label,
		description: entry.description ?? `MCP tool ${label}`,
		parameters: converted.schema,
		executionMode: "parallel",
		async execute(_toolCallId, params, signal, onUpdate): Promise<AgentToolResult<McpToolDetails | undefined>> {
			const args: Record<string, unknown> = isRecord(params) ? params : {};
			const result = await callMcpTool(entry, args, signal, onUpdate, label);
			const mapped = mapMcpToolResult(normalizeCallToolResult(result));
			if (!mapped.ok) {
				throw new ToolExecError(mapped.error.message, { phase: "call", serverName: entry.server });
			}
			const content = toAgentContent(mapped.content);
			return { content, details: { preview: previewContent(content), server: entry.server, tool: entry.tool } };
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold(`${name} ${previewArgs(args)}`.trim())), 0, 0);
		},
		renderResult(result, options, theme) {
			const title = options.isPartial
				? `${name}: running`
				: `${name}: ${result.details?.preview ?? "(empty result)"}`;
			return new Text(theme.fg("toolOutput", title), 0, 0);
		},
	};
}

async function callMcpTool(
	entry: McpToolCatalogEntry,
	args: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: Parameters<McpToolDefinition["execute"]>[3],
	label: string,
): Promise<Awaited<ReturnType<McpToolCatalogEntry["connection"]["client"]["callTool"]>>> {
	try {
		await ensureMcpToolCallConnection(entry.connection);
		await entry.ensureConnected?.();
		return await entry.connection.client.callTool({ name: entry.tool, arguments: args }, undefined, {
			onprogress: (progress) => {
				onUpdate?.({
					content: [{ type: "text", text: formatProgress(label, progress) }],
					details: { progress, server: entry.server, tool: entry.tool },
				});
			},
			signal,
			timeout: entry.requestTimeoutMs,
		});
	} catch (error) {
		throw new ToolExecError(`ToolExecError: ${errorMessage(error)}`, {
			cause: error,
			phase: "call",
			serverName: entry.server,
		});
	}
}

function normalizeCallToolResult(
	result: Awaited<ReturnType<McpToolCatalogEntry["connection"]["client"]["callTool"]>>,
): McpToolResultLike {
	if ("content" in result || "structuredContent" in result || "isError" in result) {
		const candidate = result as Record<string, unknown>;
		const normalized: McpToolResultLike = {};
		if (isMcpContentBlockArray(candidate.content)) normalized.content = candidate.content;
		if (typeof candidate.isError === "boolean") normalized.isError = candidate.isError;
		if ("structuredContent" in candidate) normalized.structuredContent = candidate.structuredContent;
		return normalized;
	}
	return { structuredContent: result.toolResult };
}

function isMcpContentBlockArray(value: unknown): value is McpContentBlock[] {
	return Array.isArray(value);
}

function toAgentContent(blocks: readonly McpMappedContentBlock[]): McpAgentContent[] {
	return blocks.map((block) => {
		if (block.type === "text" || block.type === "image") return block;
		return { type: "text", text: JSON.stringify(block) };
	});
}

function previewContent(content: readonly McpAgentContent[]): string {
	return truncatePreview(
		content
			.map((block) => (block.type === "text" ? block.text : `[${block.mimeType} image]`))
			.join(" ")
			.trim() || "(empty result)",
	);
}

function previewArgs(args: unknown): string {
	const text = JSON.stringify(args);
	return text === undefined ? "" : truncatePreview(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatProgress(label: string, progress: Progress): string {
	const total = progress.total === undefined ? "" : `/${progress.total}`;
	const message = progress.message === undefined ? "" : ` ${progress.message}`;
	return `${label} progress ${progress.progress}${total}${message}`.trim();
}

function truncatePreview(value: string): string {
	return value.length <= 120 ? value : `${value.slice(0, 117)}...`;
}

function compareCatalogEntries(left: McpToolCatalogEntry, right: McpToolCatalogEntry): number {
	return left.server.localeCompare(right.server) || left.tool.localeCompare(right.tool);
}

function buildActiveToolNames(
	entries: readonly McpToolCatalogEntry[],
	activeEntries: readonly McpToolCatalogEntry[],
	warn?: WarnFn,
): string[] {
	const activeKeys = new Set(activeEntries.map(catalogEntryKey));
	const sorted = [...entries].sort(compareCatalogEntries);
	const names = buildMcpToolNames(
		sorted.map((entry) => ({ serverName: entry.server, toolName: entry.tool })),
		warn,
	);
	return sorted
		.map((entry, index) => (activeKeys.has(catalogEntryKey(entry)) ? (names[index] ?? "") : ""))
		.filter((name) => name.length > 0)
		.sort();
}

function catalogEntryKey(entry: McpToolCatalogEntry): string {
	return `${entry.server}\0${entry.tool}`;
}
