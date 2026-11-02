import type { Api, Model, OpenAIResponsesCompat } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import {
	hasServerSearchFailed,
	isServerSearchDisabled,
	isServerSearchFallback,
	markServerSearchFallback,
} from "../server-search-fallback.ts";

type ToolDefinition = Record<string, unknown>;
type OpenAiWebSearchModel = Pick<Model<Api>, "api" | "baseUrl" | "compat"> & { provider?: string; id?: string };
type OpenAiWebSearchTarget = Api | OpenAiWebSearchModel | undefined;

const OPENAI_RESPONSES_APIS: ReadonlySet<Api> = new Set([
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
]);
const ENABLE_ENV = "PI_OPENAI_WEB_SEARCH";
// OpenAI still supports this legacy server-tool name; Codex and xAI use web_search.
// https://developers.openai.com/api/docs/guides/tools-web-search
const NATIVE_OPENAI_WEB_SEARCH_TYPE = "web_search_preview";
const WEB_SEARCH_SOURCES_INCLUDE = "web_search_call.action.sources";
const STATUS_KEY = "openai-web-search";
const WIDGET_KEY = "openai-web-search";

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

function isOpenAiResponsesApi(
	api: Api | undefined,
): api is "openai-responses" | "azure-openai-responses" | "openai-codex-responses" {
	return api !== undefined && OPENAI_RESPONSES_APIS.has(api);
}

function resolveTarget(target: OpenAiWebSearchTarget): OpenAiWebSearchModel | undefined {
	if (target === undefined) {
		return undefined;
	}
	if (typeof target === "string") {
		return { api: target, baseUrl: target === "openai-responses" ? "https://api.openai.com/v1" : "" };
	}
	return target;
}

export function supportsNativeOpenAiWebSearch(target: OpenAiWebSearchTarget): boolean {
	const model = resolveTarget(target);
	if (!isOpenAiResponsesApi(model?.api)) {
		return false;
	}
	const compat = model.compat as OpenAIResponsesCompat | undefined;
	// Codex/ChatGPT plans support web_search in their main Responses request.
	// https://developers.openai.com/codex/config-basic/#web-search-mode
	// Real subscription search and output-item replay were verified for senpi#3122.
	if (model.api === "openai-codex-responses") {
		if (model.id?.includes("-spark")) return false;
		try {
			return compat?.supportsWebSearchPreview ?? new URL(model.baseUrl).hostname === "chatgpt.com";
		} catch {
			return false;
		}
	}
	// xAI documents web_search on Responses, not its Chat Completions endpoint.
	// Compatible/custom Responses endpoints still need an explicit capability opt-in.
	// https://docs.x.ai/developers/tools/web-search
	// Preserve main's shipped Azure and first-party OpenAI defaults.
	if (model.api === "azure-openai-responses") return true;
	if (compat?.supportsWebSearchPreview !== undefined) return compat.supportsWebSearchPreview;
	try {
		return new URL(model.baseUrl || "https://api.openai.com/v1").hostname === "api.openai.com";
	} catch {
		return false;
	}
}

function isNativeOpenAiWebSearchType(
	value: unknown,
): value is "web_search" | "web_search_preview" | "web_search_preview_2025_03_11" {
	return value === "web_search" || value === "web_search_preview" || value === "web_search_preview_2025_03_11";
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

function stripNativeOpenAiWebSearch(payload: unknown): unknown {
	if (!isRecord(payload)) {
		return payload;
	}

	let changed = false;
	const sanitized: Record<string, unknown> = { ...payload };

	const tools = payload.tools;
	if (Array.isArray(tools)) {
		const sanitizedTools = tools.filter((tool) => !(isRecord(tool) && isNativeOpenAiWebSearchType(tool.type)));
		if (sanitizedTools.length !== tools.length) {
			changed = true;
			if (sanitizedTools.length) sanitized.tools = sanitizedTools;
			else delete sanitized.tools;
		}
	}

	const include = payload.include;
	if (Array.isArray(include)) {
		const sanitizedInclude = include.filter((value) => value !== WEB_SEARCH_SOURCES_INCLUDE);
		if (sanitizedInclude.length !== include.length) {
			changed = true;
			sanitized.include = sanitizedInclude;
		}
	}

	if (isRecord(payload.tool_choice) && isNativeOpenAiWebSearchType(payload.tool_choice.type)) {
		changed = true;
		delete sanitized.tool_choice;
	}

	return changed ? sanitized : payload;
}

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

function includeWebSearchSources(payload: Record<string, unknown>): string[] {
	const include = Array.isArray(payload.include)
		? payload.include.filter((value): value is string => typeof value === "string")
		: [];
	return include.includes(WEB_SEARCH_SOURCES_INCLUDE) ? include : [...include, WEB_SEARCH_SOURCES_INCLUDE];
}

export function addOpenAiWebSearchToPayload(target: OpenAiWebSearchTarget, payload: unknown): unknown {
	if (isServerSearchDisabled(payload) || isServerSearchFallback(payload)) return stripNativeOpenAiWebSearch(payload);
	const model = resolveTarget(target);
	if (!isOpenAiResponsesApi(model?.api)) {
		// Defense in depth. `web_search_preview` is an OpenAI Responses-only tool
		// type, but proxies that translate openai-responses → anthropic-messages
		// (e.g., ccapi/quotio for Claude models) can forward it verbatim, which
		// Anthropic rejects with `tools.N: Input tag 'web_search_preview'...`.
		// Strip the OpenAI-native variants for any non-openai-responses payload
		// so they never leak to Anthropic or Chat Completions backends.
		return stripNativeOpenAiWebSearch(payload);
	}

	if (!isRecord(payload)) {
		return payload;
	}

	const supportsNativeWebSearch = supportsNativeOpenAiWebSearch(model);
	const tools = Array.isArray(payload.tools) ? payload.tools : [];
	const shouldInjectWebSearch = supportsNativeWebSearch && isOpenaiWebSearchEnabled();
	const strippedPayload = supportsNativeWebSearch ? payload : stripNativeOpenAiWebSearch(payload);
	if (!isRecord(strippedPayload)) {
		return strippedPayload;
	}

	const strippedTools = Array.isArray(strippedPayload.tools) ? strippedPayload.tools : [];
	const activeTools = supportsNativeWebSearch ? tools : strippedTools;
	const sanitized = sanitizeTools(tools, { stripFunctionWebSearch: shouldInjectWebSearch });
	const sanitizedTools = sanitized.tools;
	if (!shouldInjectWebSearch) {
		const nativeStripped = strippedPayload !== payload;
		const passiveSanitized = sanitizeTools(activeTools, { stripFunctionWebSearch: false });
		if (!nativeStripped && !passiveSanitized.changed) {
			return strippedPayload;
		}

		const result: Record<string, unknown> = {
			...strippedPayload,
			tools: passiveSanitized.tools,
		};
		if (!passiveSanitized.tools.length) delete result.tools;
		return result;
	}

	const hasNativeWebSearch = sanitizedTools.some((tool) => isNativeOpenAiWebSearchType(tool.type));

	if (!hasNativeWebSearch) {
		sanitizedTools.push({
			type:
				(model.compat as OpenAIResponsesCompat | undefined)?.webSearchToolType ??
				(model.api === "openai-codex-responses" ? "web_search" : NATIVE_OPENAI_WEB_SEARCH_TYPE),
		});
	}

	return {
		...payload,
		tools: sanitizedTools,
		include: includeWebSearchSources(payload),
	};
}

export function isOpenaiWebSearchEnabled(): boolean {
	return parseEnableEnv(ENABLE_ENV);
}

function clearUi(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.setWidget(WIDGET_KEY, undefined);
}

function syncUi(ctx: ExtensionContext): void {
	clearUi(ctx);
}

export const OPENAI_WEB_SEARCH_SECTION = `
## Web Search

Native web search is available in this session.
Use web search when the user asks for current or online information.
Prefer web search over guessing when freshness matters.
`;

export default function openaiWebSearchExtension(pi: ExtensionAPI): void {
	pi.on("before_provider_request", (event, ctx) => {
		const model = event.model ?? ctx.model;
		const payload = hasServerSearchFailed(ctx.sessionManager, model)
			? markServerSearchFallback(event.payload)
			: event.payload;
		return addOpenAiWebSearchToPayload(model, payload);
	});

	pi.on("session_start", async (_event, ctx) => {
		syncUi(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		syncUi(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearUi(ctx);
	});

	pi.on(
		"before_agent_start",
		async (event, ctx) => {
			if (!supportsNativeOpenAiWebSearch(ctx.model)) {
				return undefined;
			}

			if (!isOpenaiWebSearchEnabled()) {
				return undefined;
			}

			return {
				systemPrompt: `${event.systemPrompt}\n${OPENAI_WEB_SEARCH_SECTION}`,
			};
		},
		{ previewSafe: true },
	);
}
