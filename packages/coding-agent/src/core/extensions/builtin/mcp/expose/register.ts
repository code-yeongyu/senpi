import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { Progress } from "@modelcontextprotocol/sdk/types.js";
import type { TSchema } from "typebox";
import type { ToolDefinition } from "../../../types.ts";
import { forgetDispatchApproval } from "../../permission-system/dispatch.ts";
import { registerDispatchIdentity } from "../../permission-system/dispatch-metadata.ts";
import type { McpToolCatalogEntry } from "../catalog.ts";
import { ToolExecError } from "../errors.ts";
import { applyMcpOutputGuard } from "../guard/output-guard.ts";
import type { McpInvocation, McpInvocationError } from "../invocation.ts";
import { callMcpTool } from "./call.ts";
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
	error?: McpInvocationError;
}

type McpAgentContent = TextContent | ImageContent;
export type McpToolDefinition = ToolDefinition<TSchema, McpToolDetails | undefined, unknown>;
type WarnFn = (message: string) => void;

export interface McpCatalogRegistrationOptions {
	readonly refreshActiveSetWhenEmpty?: boolean;
}

export interface McpNamedCatalogEntry {
	readonly entry: McpToolCatalogEntry;
	readonly name: string;
}

/** Pair each catalog entry with its stable, collision-resolved mcp tool name.
 * Shared by the full-tool builder and the Tier-B search catalog so names never
 * drift between the two. */
export function mapMcpCatalogNames(entries: readonly McpToolCatalogEntry[], warn?: WarnFn): McpNamedCatalogEntry[] {
	const sorted = [...entries].sort(compareCatalogEntries);
	const names = buildMcpToolNames(
		sorted.map((entry) => ({ serverName: entry.server, toolName: entry.tool })),
		warn,
	);
	return sorted.map((entry, index) => ({ entry, name: names[index] ?? "" }));
}

export function buildMcpToolDefinitions(entries: readonly McpToolCatalogEntry[], warn?: WarnFn): McpToolDefinition[] {
	return mapMcpCatalogNames(entries, warn).map(({ entry, name }) => createMcpToolDefinition(entry, name));
}

function createMcpToolDefinition(entry: McpToolCatalogEntry, name: string): McpToolDefinition {
	const converted = convertJsonSchemaToTypeBox(entry.schema);
	const label = `${entry.server}/${entry.tool}`;
	registerDispatchIdentity(converted.schema, () => entry.invocation?.identity(entry));
	return {
		name,
		label,
		description: entry.description ?? `MCP tool ${label}`,
		parameters: converted.schema,
		executionMode: "parallel",
		async execute(
			toolCallId,
			params,
			signal,
			onUpdate,
			context,
		): Promise<AgentToolResult<McpToolDetails | undefined>> {
			const args: Record<string, unknown> = isRecord(params) ? params : {};
			return await executeMcpCatalogEntry(entry, args, signal, onUpdate, {
				toolCallId,
				toolName: name,
				input: args,
				context,
			});
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

/** Full guarded call path for one catalog entry (lifecycle + retry + output
 * guard). Shared by direct/search tool definitions and the Tier-C proxy. */
export async function executeMcpCatalogEntry(
	entry: McpToolCatalogEntry,
	args: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: Parameters<McpToolDefinition["execute"]>[3],
	invocation?: McpInvocation,
): Promise<AgentToolResult<McpToolDetails | undefined>> {
	try {
		const label = `${entry.server}/${entry.tool}`;
		const outcome = await callMcpTool(entry, args, signal, onUpdate, label, invocation);
		if (outcome.kind === "refused") {
			const guarded = await applyMcpOutputGuard([{ type: "text", text: JSON.stringify({ error: outcome.error }) }], {
				agentDir: entry.agentDir,
				artifacts: entry.artifacts,
				outputGuard: entry.outputGuard,
				server: entry.server,
			});
			return {
				content: toAgentContent(guarded),
				details: { error: outcome.error, preview: outcome.error.kind, server: entry.server, tool: entry.tool },
			};
		}
		const current = outcome.entry;
		const mapped = mapMcpToolResult(normalizeCallToolResult(outcome.result));
		if (!mapped.ok) {
			throw new ToolExecError(mapped.error.message, { phase: "call", serverName: entry.server });
		}
		const guarded = await applyMcpOutputGuard(mapped.content, {
			agentDir: current.agentDir,
			artifacts: current.artifacts,
			outputGuard: current.outputGuard,
			server: current.server,
		});
		const content = toAgentContent(guarded);
		return { content, details: { preview: previewContent(content), server: entry.server, tool: entry.tool } };
	} finally {
		if (invocation !== undefined) forgetDispatchApproval(invocation.input);
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

function truncatePreview(value: string): string {
	return value.length <= 120 ? value : `${value.slice(0, 117)}...`;
}

function compareCatalogEntries(left: McpToolCatalogEntry, right: McpToolCatalogEntry): number {
	return left.server.localeCompare(right.server) || left.tool.localeCompare(right.tool);
}
