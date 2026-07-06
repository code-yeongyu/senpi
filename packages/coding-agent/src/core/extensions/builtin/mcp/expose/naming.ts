import { createHash } from "node:crypto";

export interface McpToolNameEntry {
	serverName: string;
	toolName: string;
}

export const MCP_TOOL_NAME_MAX_LENGTH = 64;

type WarnFn = (message: string) => void;

export function buildMcpToolNames(entries: readonly McpToolNameEntry[], warn?: WarnFn): string[] {
	const items = entries.map((entry, index) => ({
		base: ellipsizeMiddle(buildBaseName(entry), MCP_TOOL_NAME_MAX_LENGTH),
		entry,
		index,
	}));
	const groups = new Map<string, typeof items>();
	for (const item of items) {
		const key = matcherKey(item.base);
		const group = groups.get(key) ?? [];
		group.push(item);
		groups.set(key, group);
	}

	const names = items.map((item) => item.base);
	for (const group of groups.values()) {
		if (group.length < 2) continue;
		const [first] = group;
		if (!first) continue;
		warn?.(`MCP tool name collision after normalization for '${first.base}'; appended deterministic suffixes.`);
		for (const item of group) {
			const suffix = hashSuffix(item.entry);
			names[item.index] = `${ellipsizeMiddle(item.base, MCP_TOOL_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
		}
	}
	return names;
}

export function buildMcpToolName(entry: McpToolNameEntry): string {
	return ellipsizeMiddle(buildBaseName(entry), MCP_TOOL_NAME_MAX_LENGTH);
}

function buildBaseName(entry: McpToolNameEntry): string {
	return `mcp_${sanitizeNamePart(entry.serverName)}_${sanitizeNamePart(entry.toolName)}`;
}

function sanitizeNamePart(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function matcherKey(name: string): string {
	return name.replace(/-/g, "_");
}

function hashSuffix(entry: McpToolNameEntry): string {
	return `_${createHash("sha1").update(`${entry.serverName}\0${entry.toolName}`).digest("hex").slice(0, 4)}`;
}

function ellipsizeMiddle(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	if (maxLength <= 3) return value.slice(0, maxLength);
	const marker = "...";
	const remaining = maxLength - marker.length;
	const prefixLength = Math.ceil(remaining / 2);
	const suffixLength = Math.floor(remaining / 2);
	return `${value.slice(0, prefixLength)}${marker}${value.slice(value.length - suffixLength)}`;
}
