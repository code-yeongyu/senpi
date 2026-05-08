import type { Api } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "../../types.js";

type ToolDefinition = Record<string, unknown>;

const OPENAI_RESPONSES_APIS: ReadonlySet<Api> = new Set(["openai-responses", "azure-openai-responses"]);
const ENABLE_ENV = "PI_OPENAI_WEB_SEARCH";
const NATIVE_OPENAI_WEB_SEARCH_TYPE = "web_search_preview";

function parseEnableEnv(envVar: string): boolean {
	const envValue = process.env[envVar];
	if (!envValue) {
		return true;
	}

	const normalized = envValue.trim().toLowerCase();
	if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
		return false;
	}

	if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
		return true;
	}

	// Unknown values fall back to default-on behavior.
	return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isOpenAiResponsesApi(api: Api | undefined): api is "openai-responses" | "azure-openai-responses" {
	return api !== undefined && OPENAI_RESPONSES_APIS.has(api);
}

function isNativeOpenAiWebSearchType(value: unknown): value is "web_search_preview" | "web_search_preview_2025_03_11" {
	return value === "web_search_preview" || value === "web_search_preview_2025_03_11";
}

function isUnsupportedWebSearchType(value: unknown): boolean {
	return (
		typeof value === "string" &&
		(value === "web_search" || value.startsWith("web_search_")) &&
		!isNativeOpenAiWebSearchType(value)
	);
}

function isAnthropicWebFetchType(value: unknown): boolean {
	return typeof value === "string" && value.startsWith("web_fetch_");
}

type SanitizedTools = {
	changed: boolean;
	tools: ToolDefinition[];
};

type SanitizeToolsOptions = {
	stripFunctionWebSearch: boolean;
};

function sanitizeTools(tools: unknown[], options: SanitizeToolsOptions): SanitizedTools {
	const sanitized: ToolDefinition[] = [];
	let changed = false;
	for (const tool of tools) {
		if (!isRecord(tool)) {
			changed = true;
			continue;
		}

		const type = tool.type;
		const shouldStripFunctionVariant =
			options.stripFunctionWebSearch && tool.name === "web_search" && !isNativeOpenAiWebSearchType(type);
		const shouldStripProviderNativeVariant = isUnsupportedWebSearchType(type) || isAnthropicWebFetchType(type);
		if (shouldStripFunctionVariant || shouldStripProviderNativeVariant) {
			changed = true;
		} else {
			sanitized.push(tool);
		}
	}

	return { changed, tools: sanitized };
}

export function addOpenAiWebSearchToPayload(api: Api | undefined, payload: unknown): unknown {
	if (!isOpenAiResponsesApi(api)) {
		return payload;
	}

	if (!isRecord(payload)) {
		return payload;
	}

	const tools = Array.isArray(payload.tools) ? payload.tools : [];
	const shouldInjectWebSearch = isOpenaiWebSearchEnabled();
	const sanitized = sanitizeTools(tools, { stripFunctionWebSearch: shouldInjectWebSearch });
	const sanitizedTools = sanitized.tools;
	if (!shouldInjectWebSearch) {
		if (!sanitized.changed) {
			return payload;
		}

		return {
			...payload,
			tools: sanitizedTools,
		};
	}

	const hasNativeWebSearch = sanitizedTools.some((tool) => isNativeOpenAiWebSearchType(tool.type));

	if (!hasNativeWebSearch) {
		sanitizedTools.push({ type: NATIVE_OPENAI_WEB_SEARCH_TYPE });
	}

	return {
		...payload,
		tools: sanitizedTools,
	};
}

export function isOpenaiWebSearchEnabled(): boolean {
	return parseEnableEnv(ENABLE_ENV);
}

export const OPENAI_WEB_SEARCH_SECTION = `
## Web Search

Native web search is available in this session.
Use web search when the user asks for current or online information.
Prefer web search over guessing when freshness matters.
`;

export default function openaiWebSearchExtension(pi: ExtensionAPI): void {
	pi.on("before_provider_request", (event, ctx) => {
		return addOpenAiWebSearchToPayload(ctx.model?.api, event.payload);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!isOpenAiResponsesApi(ctx.model?.api)) {
			return undefined;
		}

		if (!isOpenaiWebSearchEnabled()) {
			return undefined;
		}

		return {
			systemPrompt: `${event.systemPrompt}\n${OPENAI_WEB_SEARCH_SECTION}`,
		};
	});
}
