import type { Api } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "../../types.js";

type ToolDefinition = Record<string, unknown>;
type ToolSearchMode = "off" | "regex" | "bm25" | "both";

const TOOL_SEARCH_ENV = "PI_ANTHROPIC_TOOL_SEARCH";
const REGEX_TOOL_TYPE = "tool_search_tool_regex_20251119";
const BM25_TOOL_TYPE = "tool_search_tool_bm25_20251119";
const REGEX_TOOL_NAME = "tool_search_tool_regex";
const BM25_TOOL_NAME = "tool_search_tool_bm25";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseToolSearchMode(rawValue: string | undefined): ToolSearchMode {
	if (!rawValue) {
		return "off";
	}

	const normalized = rawValue.trim().toLowerCase();
	if (!normalized || normalized === "off") {
		return "off";
	}

	if (normalized === "regex" || normalized === "bm25" || normalized === "both") {
		return normalized;
	}

	return "off";
}

function isToolSearchType(value: unknown): value is string {
	return typeof value === "string" && value.startsWith("tool_search_tool_");
}

function isNativeToolSearchTool(tool: ToolDefinition): boolean {
	const name = tool.name;
	return name === REGEX_TOOL_NAME || name === BM25_TOOL_NAME;
}

function sanitizeTools(tools: unknown[]): ToolDefinition[] {
	const sanitized: ToolDefinition[] = [];
	for (const tool of tools) {
		if (!isRecord(tool)) {
			continue;
		}

		const isFunctionVariant = isNativeToolSearchTool(tool) && !isToolSearchType(tool.type);
		if (!isFunctionVariant) {
			sanitized.push(tool);
		}
	}
	return sanitized;
}

function selectTools(mode: ToolSearchMode): ToolDefinition[] {
	if (mode === "regex") {
		return [{ type: REGEX_TOOL_TYPE, name: REGEX_TOOL_NAME }];
	}

	if (mode === "bm25") {
		return [{ type: BM25_TOOL_TYPE, name: BM25_TOOL_NAME }];
	}

	if (mode === "both") {
		return [
			{ type: REGEX_TOOL_TYPE, name: REGEX_TOOL_NAME },
			{ type: BM25_TOOL_TYPE, name: BM25_TOOL_NAME },
		];
	}

	return [];
}

export function addAnthropicToolSearchToPayload(api: Api | undefined, payload: unknown): unknown {
	if (api !== "anthropic-messages") {
		return payload;
	}

	if (!isRecord(payload)) {
		return payload;
	}

	const mode = parseToolSearchMode(process.env[TOOL_SEARCH_ENV]);
	if (mode === "off") {
		return payload;
	}

	const tools = Array.isArray(payload.tools) ? payload.tools : [];
	const sanitizedTools = sanitizeTools(tools);
	const selectedTools = selectTools(mode);
	for (const selectedTool of selectedTools) {
		const exists = sanitizedTools.some((tool) => tool.name === selectedTool.name);
		if (!exists) {
			sanitizedTools.push(selectedTool);
		}
	}

	return {
		...payload,
		tools: sanitizedTools,
	};
}

export const ANTHROPIC_TOOL_SEARCH_SECTION = `
## Tool Search

Anthropic native tool search is enabled. Use tool_search_tool_regex or tool_search_tool_bm25 to discover relevant tools from large catalogs before calling them.
`;

export default function anthropicToolSearchExtension(pi: ExtensionAPI): void {
	let hasWarnedInvalidEnvValue = false;

	pi.on("before_provider_request", (event, ctx) => {
		const envValue = process.env[TOOL_SEARCH_ENV];
		const mode = parseToolSearchMode(envValue);
		const hasInvalidEnvValue = !!envValue && mode === "off" && envValue.trim().toLowerCase() !== "off";

		if (hasInvalidEnvValue && !hasWarnedInvalidEnvValue) {
			hasWarnedInvalidEnvValue = true;
			ctx.ui.notify(
				`Ignoring invalid ${TOOL_SEARCH_ENV} value "${envValue}". Use off, regex, bm25, or both.`,
				"warning",
			);
		}

		return addAnthropicToolSearchToPayload(ctx.model?.api, event.payload);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (ctx.model?.api !== "anthropic-messages") {
			return undefined;
		}

		const mode = parseToolSearchMode(process.env[TOOL_SEARCH_ENV]);
		if (mode === "off") {
			return undefined;
		}

		return {
			systemPrompt: `${event.systemPrompt}\n${ANTHROPIC_TOOL_SEARCH_SECTION}`,
		};
	});
}
