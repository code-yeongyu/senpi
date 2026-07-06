import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type TSchema, Type } from "typebox";
import { buildMcpToolName, buildMcpToolNames, type McpToolNameEntry } from "./naming.ts";
import { collectAllPages, type McpListPage, type McpPaginationResult } from "./pagination.ts";

export type { McpListPage, McpPaginationResult, McpToolNameEntry };
export { buildMcpToolName, buildMcpToolNames, collectAllPages };

interface SchemaConversionResult {
	schema: TSchema;
	warnings: string[];
}

interface OutputSchemaRetryResult {
	schema: Record<string, unknown>;
	warnings: string[];
}

export type McpContentBlock =
	| { type: "text"; text?: unknown }
	| { type: "image"; data?: unknown; mimeType?: unknown }
	| { type: "audio"; data?: unknown; mimeType?: unknown }
	| { type: "resource"; resource?: unknown }
	| { type: "resource_link"; uri?: unknown; name?: unknown; description?: unknown; mimeType?: unknown }
	| Record<string, unknown>;

export type McpMappedContentBlock =
	| TextContent
	| ImageContent
	| { type: "audio"; data: string; mimeType: string }
	| { type: "resource"; resource: unknown }
	| { type: "resource_link"; uri: string; name?: string; description?: string; mimeType?: string };

export interface McpToolResultLike {
	content?: McpContentBlock[];
	structuredContent?: unknown;
	isError?: boolean;
}

export type McpMappedToolResult =
	| { ok: true; content: McpMappedContentBlock[] }
	| { ok: false; error: { message: string; content: McpMappedContentBlock[] } };

const PERMISSIVE_OBJECT_SCHEMA = { type: "object", properties: {} } as const;

export function convertJsonSchemaToTypeBox(schema: unknown): SchemaConversionResult {
	const warnings: string[] = [];
	const resolved = resolveRefs(stripTopLevelSchemaKeys(schema), schema, new Set<string>(), warnings);
	if (warnings.length > 0) {
		return { schema: Type.Unsafe<unknown>({ ...PERMISSIVE_OBJECT_SCHEMA }), warnings };
	}
	if (!isRecord(resolved)) {
		return {
			schema: Type.Unsafe<unknown>({ ...PERMISSIVE_OBJECT_SCHEMA }),
			warnings: ["MCP schema is not an object; using permissive object schema."],
		};
	}
	return { schema: Type.Unsafe<unknown>(resolved), warnings };
}

export function prepareOutputSchemaRetry(schema: unknown): OutputSchemaRetryResult {
	const warnings: string[] = [];
	const record: Record<string, unknown> = isRecord(schema) ? { ...schema } : { ...PERMISSIVE_OBJECT_SCHEMA };
	if (hasOwn(record, "$schema")) {
		delete record.$schema;
		warnings.push("Stripped top-level $schema from MCP outputSchema retry.");
	}
	if (hasOwn(record, "additionalProperties")) {
		delete record.additionalProperties;
		warnings.push("Stripped top-level additionalProperties from MCP outputSchema retry.");
	}
	return { schema: record, warnings };
}

export function mapMcpToolResult(result: McpToolResultLike): McpMappedToolResult {
	const content = mapMcpContent(result);
	if (result.isError === true) {
		return { ok: false, error: { message: contentToErrorMessage(content), content } };
	}
	return { ok: true, content };
}

function mapMcpContent(result: McpToolResultLike): McpMappedContentBlock[] {
	const content: McpMappedContentBlock[] = [];
	for (const block of result.content ?? []) {
		content.push(mapContentBlock(block));
	}
	if (result.structuredContent !== undefined) {
		content.push({ type: "text", text: stringifyJson(result.structuredContent) });
	}
	if (content.length === 0) {
		content.push({ type: "text", text: "(empty result)" });
	}
	return content;
}

function mapContentBlock(block: McpContentBlock): McpMappedContentBlock {
	if (block.type === "text") {
		return { type: "text", text: typeof block.text === "string" ? block.text : stringifyJson(block.text) };
	}
	if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
		return { type: "image", data: block.data, mimeType: block.mimeType };
	}
	if (block.type === "audio" && typeof block.data === "string" && typeof block.mimeType === "string") {
		return { type: "audio", data: block.data, mimeType: block.mimeType };
	}
	if (block.type === "resource" && hasOwn(block, "resource")) {
		return { type: "resource", resource: block.resource };
	}
	if (block.type === "resource_link" && typeof block.uri === "string") {
		return {
			type: "resource_link",
			uri: block.uri,
			...(typeof block.name === "string" ? { name: block.name } : {}),
			...(typeof block.description === "string" ? { description: block.description } : {}),
			...(typeof block.mimeType === "string" ? { mimeType: block.mimeType } : {}),
		};
	}
	return { type: "text", text: stringifyJson(block) };
}

function contentToErrorMessage(content: readonly McpMappedContentBlock[]): string {
	const firstText = content.find((block): block is TextContent => block.type === "text");
	return firstText?.text.trim() || "MCP tool returned an error result.";
}

function stripTopLevelSchemaKeys(schema: unknown): unknown {
	if (!isRecord(schema)) return schema;
	const result = { ...schema };
	delete result.$schema;
	delete result.additionalProperties;
	return result;
}

function resolveRefs(value: unknown, root: unknown, seenRefs: Set<string>, warnings: string[]): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => resolveRefs(entry, root, seenRefs, warnings));
	}
	if (!isRecord(value)) return value;

	if (typeof value.$ref === "string") {
		const ref = value.$ref;
		const resolved = resolveLocalRef(root, ref);
		if (resolved === undefined || seenRefs.has(ref)) {
			warnings.push(`MCP schema contains unresolvable $ref '${ref}'; using permissive object schema.`);
			return { ...PERMISSIVE_OBJECT_SCHEMA };
		}
		const nextSeenRefs = new Set(seenRefs);
		nextSeenRefs.add(ref);
		return resolveRefs(resolved, root, nextSeenRefs, warnings);
	}

	const result: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		result[key] = resolveRefs(child, root, seenRefs, warnings);
	}
	return result;
}

function resolveLocalRef(root: unknown, ref: string): unknown {
	if (!ref.startsWith("#/")) return undefined;
	let current: unknown = root;
	for (const part of ref
		.slice(2)
		.split("/")
		.map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))) {
		if (!isRecord(current) || !(part in current)) return undefined;
		current = current[part];
	}
	return current;
}

function stringifyJson(value: unknown): string {
	const text = JSON.stringify(value);
	return text ?? String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
	return Object.getOwnPropertyDescriptor(value, key) !== undefined;
}
