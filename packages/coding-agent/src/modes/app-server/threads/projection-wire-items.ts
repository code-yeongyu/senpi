import type { AssistantMessage, ProviderNativeContent } from "@earendil-works/pi-ai";
import { formatProviderNativeBody, formatProviderNativeSummary } from "../../provider-native-rendering.ts";
import { fileChangeProjection } from "./projection-file-changes.ts";
import { webSearchItem } from "./projection-web-search.ts";
import type { WireItem } from "./turn-log.ts";

export type ToolItemType = "commandExecution" | "fileChange" | "mcpToolCall" | "dynamicToolCall";

export type ActiveToolItem = {
	readonly id: string;
	readonly name: string;
	readonly itemType: ToolItemType;
	readonly args: unknown;
	output: string;
	completed: boolean;
};

export type ToolExecutionStatus = "inProgress" | "completed" | "failed";

export type ToolWireProjection = {
	readonly item: WireItem;
	readonly diff: string;
};

const MAX_TOOL_OUTPUT_BYTES = 256 * 1024;
const MCP_TOOL_NAME_PATTERN = /^[^_]+__/;

export function classifyTool(name: string): ToolItemType {
	if (name === "bash") return "commandExecution";
	if (name === "edit" || name === "write" || name === "apply_patch") return "fileChange";
	if (MCP_TOOL_NAME_PATTERN.test(name)) return "mcpToolCall";
	return "dynamicToolCall";
}

export function remainingCommandOutputBytes(output: string): number {
	return MAX_TOOL_OUTPUT_BYTES - byteLength(output);
}

export function capCommandOutput(value: string, maxBytes = MAX_TOOL_OUTPUT_BYTES): string {
	return capUtf8(value, maxBytes);
}

export function extractToolText(result: unknown): string {
	if (!isRecord(result)) return "";
	const content = result.content;
	if (!Array.isArray(content)) return readString(result, "text") ?? "";
	return content
		.map((item) => (isRecord(item) && item.type === "text" ? (readString(item, "text") ?? "") : ""))
		.join("");
}

export function commandExecutionItem(
	tool: ActiveToolItem,
	status: ToolExecutionStatus,
	cwd: string,
	result: unknown,
): WireItem {
	return {
		type: "commandExecution",
		id: tool.id,
		command: commandFromArgs(tool.args),
		cwd,
		processId: null,
		source: "agent",
		status,
		commandActions: [],
		aggregatedOutput: tool.output || null,
		exitCode: status === "inProgress" ? null : exitCodeFromResult(result),
		durationMs: null,
	};
}

export function mcpToolCallItem(tool: ActiveToolItem, status: ToolExecutionStatus, result: unknown): WireItem {
	const [server, toolName] = splitMcpName(tool.name);
	return {
		type: "mcpToolCall",
		id: tool.id,
		server,
		tool: toolName,
		status,
		arguments: toJsonValue(tool.args),
		appContext: null,
		pluginId: null,
		result:
			status === "completed" ? { content: toolResultContent(result), structuredContent: null, _meta: null } : null,
		error: status === "failed" ? { message: extractToolText(result) || "Tool execution failed" } : null,
		durationMs: null,
	};
}

export function dynamicToolCallItem(
	tool: ActiveToolItem,
	status: ToolExecutionStatus,
	result: unknown,
	isError: boolean,
): WireItem {
	return {
		type: "dynamicToolCall",
		id: tool.id,
		namespace: null,
		tool: tool.name,
		arguments: toJsonValue(tool.args),
		status,
		contentItems: status === "inProgress" ? null : [{ type: "inputText", text: extractToolText(result) }],
		success: status === "inProgress" ? null : !isError,
		durationMs: null,
	};
}

export function toolWireProjection(input: {
	readonly tool: ActiveToolItem;
	readonly status: ToolExecutionStatus;
	readonly cwd: string;
	readonly result: unknown;
	readonly isError: boolean;
}): ToolWireProjection {
	switch (input.tool.itemType) {
		case "commandExecution":
			return { item: commandExecutionItem(input.tool, input.status, input.cwd, input.result), diff: "" };
		case "fileChange":
			return fileChangeProjection({
				id: input.tool.id,
				name: input.tool.name,
				args: input.tool.args,
				status: input.status,
				result: input.result,
			});
		case "mcpToolCall":
			return { item: mcpToolCallItem(input.tool, input.status, input.result), diff: "" };
		case "dynamicToolCall":
			return {
				item: dynamicToolCallItem(input.tool, input.status, input.result, input.isError),
				diff: "",
			};
		default:
			return assertNeverToolItem(input.tool.itemType);
	}
}

export function providerNativeItem(id: string, message: AssistantMessage, content: ProviderNativeContent): WireItem {
	if (content.subtype === "web_search_call") return webSearchItem(id, content);
	const summary = formatProviderNativeSummary(message, content, true);
	const body = formatProviderNativeBody(content, true);
	return { type: "webSearch", id, query: body ? `${summary}\n${body}` : summary, action: null, results: null };
}

export function buildWireItem(item: WireItem): WireItem {
	return { ...item };
}

function commandFromArgs(args: unknown): string {
	if (!isRecord(args)) return "";
	const command = readString(args, "command") ?? readString(args, "cmd");
	return command ?? stringifyJson(toJsonValue(args));
}

function splitMcpName(name: string): readonly [string, string] {
	const marker = name.indexOf("__");
	return marker === -1 ? ["", name] : [name.slice(0, marker), name.slice(marker + 2)];
}

function exitCodeFromResult(result: unknown): number | null {
	if (!isRecord(result)) return null;
	const details = isRecord(result.details) ? result.details : undefined;
	const value = details ? (details.exitCode ?? details.code) : undefined;
	return typeof value === "number" ? value : null;
}

function toolResultContent(result: unknown): readonly unknown[] {
	if (!isRecord(result) || !Array.isArray(result.content)) return [];
	return result.content.map(toJsonValue);
}

function capUtf8(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	let used = 0;
	let result = "";
	for (const char of value) {
		const size = byteLength(char);
		if (used + size > maxBytes) break;
		used += size;
		result += char;
	}
	return result;
}

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function toJsonValue(value: unknown): unknown {
	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string")
		return value;
	if (Array.isArray(value)) return value.map(toJsonValue);
	if (!isRecord(value)) return null;
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toJsonValue(entry)]));
}

function stringifyJson(value: unknown): string {
	return JSON.stringify(value) ?? "";
}

function assertNeverToolItem(value: never): never {
	throw new Error(`Unhandled tool item type: ${String(value)}`);
}
