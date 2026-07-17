import type { AnthropicMessagesCompat, Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";

type ToolDefinition = Record<string, unknown>;
type AnthropicWebSearchModel = Pick<Model<Api>, "api" | "provider" | "baseUrl" | "compat">;
type AnthropicWebSearchTarget = Api | AnthropicWebSearchModel | undefined;

const WEB_SEARCH_MAX_USES = 8;
const ENABLE_ENV = "PI_ANTHROPIC_WEB_SEARCH";
const ALLOWED_DOMAINS_ENV = "PI_ANTHROPIC_WEB_SEARCH_ALLOWED_DOMAINS";
const BLOCKED_DOMAINS_ENV = "PI_ANTHROPIC_WEB_SEARCH_BLOCKED_DOMAINS";
const STATUS_KEY = "anthropic-web-search";
const WIDGET_KEY = "anthropic-web-search";

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

function isWebSearchType(value: unknown): value is string {
	return typeof value === "string" && value.startsWith("web_search_");
}

function resolveTarget(target: AnthropicWebSearchTarget): AnthropicWebSearchModel | undefined {
	if (target === undefined) {
		return undefined;
	}
	if (typeof target === "string") {
		return {
			api: target,
			baseUrl: target === "anthropic-messages" ? "https://api.anthropic.com" : "",
			provider: target === "anthropic-messages" ? "anthropic" : "",
		};
	}
	return target;
}

function isNativeAnthropicEndpoint(model: AnthropicWebSearchModel): boolean {
	try {
		return new URL(model.baseUrl).hostname === "api.anthropic.com";
	} catch {
		return false;
	}
}

// Mirrors pi-ai's `AnthropicMessagesCompat.supportsWebSearch` default:
// first-party api.anthropic.com only. Anthropic-compatible endpoints (e.g.,
// kimi-coding) may execute the server-side search but reject the replayed
// server_tool_use / web_search_tool_result blocks on the next request.
export function supportsNativeAnthropicWebSearch(target: AnthropicWebSearchTarget): boolean {
	const model = resolveTarget(target);
	if (model?.api !== "anthropic-messages") {
		return false;
	}

	const compat = model.compat as AnthropicMessagesCompat | undefined;
	return compat?.supportsWebSearch ?? isNativeAnthropicEndpoint(model);
}

function parseDomainListEnv(envVar: string): string[] | undefined {
	const envValue = process.env[envVar];
	if (!envValue) {
		return undefined;
	}

	const domains = envValue
		.split(",")
		.map((domain) => domain.trim())
		.filter((domain) => domain.length > 0);

	if (domains.length === 0) {
		return undefined;
	}

	return domains;
}

function makeWebSearchTool(): ToolDefinition {
	const allowedDomains = parseDomainListEnv(ALLOWED_DOMAINS_ENV);
	const blockedDomains = parseDomainListEnv(BLOCKED_DOMAINS_ENV);

	return {
		type: "web_search_20250305",
		name: "web_search",
		...(allowedDomains ? { allowed_domains: allowedDomains } : {}),
		...(blockedDomains ? { blocked_domains: blockedDomains } : {}),
		max_uses: WEB_SEARCH_MAX_USES,
	};
}

function sanitizeTools(tools: unknown[]): ToolDefinition[] {
	const sanitized: ToolDefinition[] = [];
	for (const tool of tools) {
		if (!isRecord(tool)) {
			continue;
		}

		const name = tool.name;
		const type = tool.type;
		const shouldStripFunctionVariant = name === "web_search" && !isWebSearchType(type);
		if (!shouldStripFunctionVariant) {
			sanitized.push(tool);
		}
	}
	return sanitized;
}

function stripNativeAnthropicWebSearch(payload: Record<string, unknown>): Record<string, unknown> {
	const tools = payload.tools;
	if (!Array.isArray(tools)) {
		return payload;
	}

	const sanitizedTools = tools.filter((tool) => !(isRecord(tool) && isWebSearchType(tool.type)));
	if (sanitizedTools.length === tools.length) {
		return payload;
	}

	const sanitizedPayload = { ...payload };
	if (sanitizedTools.length > 0) {
		sanitizedPayload.tools = sanitizedTools;
	} else {
		delete sanitizedPayload.tools;
	}

	if (isRecord(sanitizedPayload.tool_choice)) {
		const selectedName = sanitizedPayload.tool_choice.name;
		const hasSelectedTool =
			typeof selectedName === "string" &&
			sanitizedTools.some((tool) => isRecord(tool) && tool.name === selectedName);
		if (sanitizedTools.length === 0 || (typeof selectedName === "string" && !hasSelectedTool)) {
			delete sanitizedPayload.tool_choice;
		}
	}

	return sanitizedPayload;
}

export function addAnthropicWebSearchToPayload(target: AnthropicWebSearchTarget, payload: unknown): unknown {
	const model = resolveTarget(target);
	if (model?.api !== "anthropic-messages") {
		return payload;
	}

	if (!isRecord(payload)) {
		return payload;
	}

	if (!supportsNativeAnthropicWebSearch(model)) {
		// Anthropic-compatible endpoints (e.g., kimi-coding) may execute the
		// server-side search but reject the replayed server_tool_use /
		// web_search_tool_result blocks on the next request. Strip any native
		// web_search_* variant so the session never wedges; a function-tool
		// web_search (pi-websearch) is left untouched as the working fallback.
		return stripNativeAnthropicWebSearch(payload);
	}

	if (!isAnthropicWebSearchEnabled()) {
		return payload;
	}

	const tools = Array.isArray(payload.tools) ? payload.tools : [];
	const sanitizedTools = sanitizeTools(tools);
	const hasNativeWebSearch = sanitizedTools.some((tool) => isWebSearchType(tool.type));
	if (!hasNativeWebSearch) {
		sanitizedTools.push(makeWebSearchTool());
	}

	return {
		...payload,
		tools: sanitizedTools,
	};
}

export function isAnthropicWebSearchEnabled(): boolean {
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

export const ANTHROPIC_WEB_SEARCH_SECTION = `
## Web Search

The native web_search tool is available in this session.
Use web_search when the user asks for current or online information.
Prefer web_search over guessing when freshness matters.
`;

export default function anthropicWebSearchExtension(pi: ExtensionAPI): void {
	pi.on("before_provider_request", (event, ctx) => {
		return addAnthropicWebSearchToPayload(ctx.model, event.payload);
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

	pi.on("before_agent_start", async (event, ctx) => {
		if (!supportsNativeAnthropicWebSearch(ctx.model)) {
			return undefined;
		}

		if (!isAnthropicWebSearchEnabled()) {
			return undefined;
		}

		return {
			systemPrompt: `${event.systemPrompt}\n${ANTHROPIC_WEB_SEARCH_SECTION}`,
		};
	});
}
