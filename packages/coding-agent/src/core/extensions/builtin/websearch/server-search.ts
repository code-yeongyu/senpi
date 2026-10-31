import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { isAnthropicWebSearchEnabled, supportsNativeAnthropicWebSearch } from "../anthropic-web-search/index.ts";
import { isOpenaiWebSearchEnabled, supportsNativeOpenAiWebSearch } from "../openai-web-search/index.ts";
import { isServerSearchDisabled, isServerSearchFallback, SERVER_SEARCH_FALLBACK } from "../server-search-fallback.ts";

export type SearchModel = Pick<Model<Api>, "api" | "provider" | "id" | "baseUrl" | "compat">;
type Payload = Record<string, unknown>;
type AdditionalServerSearch = "google" | "openrouter" | "perplexity" | "moonshot" | "zai";

function isRecord(value: unknown): value is Payload {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function additionalServerSearch(model: SearchModel | undefined): AdditionalServerSearch | undefined {
	if (!model) return undefined;
	const declared = model.compat && "supportsWebSearch" in model.compat ? model.compat.supportsWebSearch : undefined;
	if (declared !== true) return undefined;
	// Google Search grounding uses GenerateContent config.tools, not Messages/Responses.
	// Gemini 2/3 document this native tool, but search mixed with function tools
	// remains opt-in until a live endpoint probe succeeds.
	// https://ai.google.dev/gemini-api/docs/google-search
	// https://github.com/googleapis/js-genai/blob/main/codegen_instructions.md
	if (
		(model.api === "google-generative-ai" || model.api === "google-vertex") &&
		/^gemini-(?:2[.-]|3[.-]|flash-latest|pro-latest)/.test(model.id) &&
		!/(image|live|tts|embedding|computer-use)/.test(model.id)
	) {
		return "google";
	}
	// OpenRouter's own server tool works on Chat Completions and Responses.
	// Do not translate it into the upstream vendor's tool shape.
	// https://openrouter.ai/docs/guides/features/server-tools/web-search
	if (model.provider === "openrouter" && (model.api === "openai-completions" || model.api === "openai-responses")) {
		return "openrouter";
	}
	// PAYG Moonshot executes $web_search and returns its result in generated
	// arguments; the client echoes those arguments as a tool result, without
	// making another search request. This is NOT the Kimi coding-plan endpoint.
	// https://platform.kimi.ai/docs/guide/use-web-search
	if (model.api === "openai-completions" && (model.provider === "moonshotai" || model.provider === "moonshotai-cn")) {
		return "moonshot";
	}
	// The same provider id can point at PAYG chat or the coding-plan endpoint.
	// Only an explicit per-route flag enables the PAYG in-chat server tool.
	// https://docs.z.ai/guides/tools/web-search
	// https://docs.z.ai/devpack/mcp/search-mcp-server
	if (
		model.api === "openai-completions" &&
		(model.provider === "zai" || model.provider === "z-ai") &&
		declared === true
	) {
		return "zai";
	}
	// Sonar searches inside the main completion without a tools[] declaration.
	// Synchronous Sonar calls are now reformulated as Agent API calls upstream.
	// https://docs.perplexity.ai/docs/sonar/quickstart
	if (model.provider === "perplexity" && model.api === "openai-completions" && /^sonar/.test(model.id)) {
		return "perplexity";
	}
	// DeepSeek documents search on /anthropic, not the default Chat Completions API.
	// An Anthropic-format model opts in through compat.supportsWebSearch, including replay.
	// https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code
	// Kimi coding-plan docs do not specify a search/replay contract. Keep the explicit
	// Messages compat opt-in; do not confuse it with PAYG's deprecated $web_search.
	// https://www.kimi.com/code/docs/en/third-party-tools/claude-code
	// https://platform.kimi.ai/docs/guide/use-web-search
	// GLM coding-plan search is documented as webSearchPrime over remote MCP, not
	// the PAYG chat tool. Do not inject the PAYG tool on the coding endpoint.
	// https://docs.z.ai/devpack/mcp/search-mcp-server
	// https://docs.z.ai/guides/tools/web-search
	return undefined;
}

export function hasServerSearch(model: SearchModel | undefined): boolean {
	if (!model) return false;
	return (
		(supportsNativeAnthropicWebSearch(model) && isAnthropicWebSearchEnabled()) ||
		(supportsNativeOpenAiWebSearch(model) && isOpenaiWebSearchEnabled()) ||
		additionalServerSearch(model) !== undefined
	);
}

function isMoonshotSearchTool(tool: unknown): boolean {
	return (
		isRecord(tool) &&
		(tool.name === "$web_search" || (isRecord(tool.function) && tool.function.name === "$web_search"))
	);
}

function isClientSearchTool(tool: unknown): boolean {
	return (
		isRecord(tool) &&
		(tool.type === "function" || "input_schema" in tool) &&
		(tool.name === "web_search" || (isRecord(tool.function) && tool.function.name === "web_search"))
	);
}

function withTools(payload: Payload, tools: unknown[]): Payload {
	const result = { ...payload };
	if (tools.length) result.tools = tools;
	else delete result.tools;
	return result;
}

function isSearchTool(tool: unknown): boolean {
	if (!isRecord(tool)) return false;
	return (
		tool.name === "web_search" ||
		isMoonshotSearchTool(tool) ||
		(isRecord(tool.function) && tool.function.name === "web_search") ||
		(typeof tool.type === "string" &&
			(tool.type === "openrouter:web_search" || tool.type === "web_search" || tool.type.startsWith("web_search_")))
	);
}

function googleTools(tools: unknown[], retainFunction: boolean, disabled: boolean): unknown[] {
	const result: unknown[] = [];
	for (const tool of tools) {
		if (!isRecord(tool) || "googleSearch" in tool || "google_search" in tool) continue;
		if (!Array.isArray(tool.functionDeclarations)) {
			result.push(tool);
			continue;
		}
		const declarations = tool.functionDeclarations.filter(
			(declaration) => !isRecord(declaration) || retainFunction || declaration.name !== "web_search",
		);
		if (declarations.length) result.push({ ...tool, functionDeclarations: declarations });
	}
	if (!retainFunction && !disabled) result.push({ googleSearch: {} });
	return result;
}

/** Preserve adapter-built function search on fallback; never reconstruct its normalized schema. */
export function serverSearchPayload(model: SearchModel | undefined, payload: unknown, failed = false): unknown {
	if (!isRecord(payload)) return payload;
	const disabled = isServerSearchDisabled(payload);
	const fallback = failed || isServerSearchFallback(payload);
	if (additionalServerSearch(model) !== "moonshot") {
		if (isMoonshotSearchTool(payload.tool_choice)) {
			const { tool_choice: _choice, ...rest } = payload;
			payload = rest;
		}
		if (!isRecord(payload)) return payload;
		if (Array.isArray(payload.tools)) {
			const tools = payload.tools.filter((tool) => !isMoonshotSearchTool(tool));
			if (tools.length !== payload.tools.length) payload = withTools(payload, tools);
		}
		if (isRecord(payload) && isRecord(payload.config) && Array.isArray(payload.config.tools)) {
			payload = {
				...payload,
				config: withTools(
					payload.config,
					payload.config.tools.flatMap((tool) => {
						if (!isRecord(tool) || !Array.isArray(tool.functionDeclarations)) return [tool];
						const declarations = tool.functionDeclarations.filter(
							(declaration) => !isMoonshotSearchTool(declaration),
						);
						return declarations.length ? [{ ...tool, functionDeclarations: declarations }] : [];
					}),
				),
			};
		}
	}
	if (!model || !isRecord(payload)) return payload;
	const google = model.api === "google-generative-ai" || model.api === "google-vertex";
	if (google && (additionalServerSearch(model) === "google" || fallback || disabled)) {
		const config = isRecord(payload.config) ? payload.config : {};
		const tools = Array.isArray(config.tools) ? config.tools : [];
		return {
			...payload,
			config: withTools(config, googleTools(tools, fallback || disabled, disabled)),
			...(fallback ? { [SERVER_SEARCH_FALLBACK]: true } : {}),
		};
	}
	const kind = additionalServerSearch(model);
	if (!fallback && !kind && !disabled) return payload;
	const tools = (Array.isArray(payload.tools) ? payload.tools : []).filter((tool) => {
		if (!isSearchTool(tool)) return true;
		if (!disabled && !fallback) return false;
		// Responses/Completions use type:function; Messages uses input_schema.
		// These declarations already came through their provider's schema builder.
		return isClientSearchTool(tool);
	});
	if (!fallback && !disabled && kind === "openrouter") {
		tools.push({ type: "openrouter:web_search" });
	} else if (!fallback && !disabled && kind === "moonshot") {
		tools.push({ type: "builtin_function", function: { name: "$web_search" } });
	} else if (!fallback && !disabled && kind === "zai") {
		tools.push({ type: "web_search", web_search: { enable: true, search_result: true } });
	}
	const result = withTools(payload, tools);
	if (fallback || disabled) {
		// An include or tool_choice targeting the removed server tool would reject the retry.
		if (Array.isArray(result.include)) {
			result.include = result.include.filter((item) => item !== "web_search_call.action.sources");
		}
		if (
			isRecord(result.tool_choice) &&
			isSearchTool(result.tool_choice) &&
			!isClientSearchTool(result.tool_choice) &&
			!(result.tool_choice.name === "web_search" && tools.some(isClientSearchTool))
		)
			delete result.tool_choice;
	}
	return fallback ? { ...result, [SERVER_SEARCH_FALLBACK]: true } : result;
}

/** Only search-specific errors trigger fallback; cancellation and unrelated provider failures do not. */
export function serverSearchFailure(
	message: Pick<AssistantMessage, "stopReason" | "content" | "errorMessage">,
	model?: SearchModel,
): string | undefined {
	if (message.stopReason === "aborted") return undefined;
	// Sonar has inherent retrieval, not an independent server tool declaration or
	// tool-result error contract. Its model errors stay with core retry; never
	// turn an arbitrary Sonar error into an unsupported function-tool request.
	if (model?.provider === "perplexity" && model.api === "openai-completions" && /^sonar/.test(model.id))
		return undefined;
	for (const block of message.content) {
		if (block.type !== "providerNative" || !isRecord(block.raw)) continue;
		const raw = block.raw;
		if (raw.type === "web_search_call" && raw.status === "failed") {
			return "server search result: failed";
		}
		if (raw.type !== "web_search_tool_result" || !isRecord(raw.content)) continue;
		if (raw.content.type === "web_search_tool_result_error" && typeof raw.content.error_code === "string") {
			return `server search result: ${raw.content.error_code.replace(/[^a-z_]/g, "").slice(0, 60)}`;
		}
	}
	if (
		message.stopReason === "error" &&
		/(\b401\b|invalid[_ -]?(?:api[_ -]?)?key|authentication|unauthorized|quota|billing|insufficient)/i.test(
			message.errorMessage ?? "",
		)
	) {
		return undefined;
	}
	if (
		message.stopReason === "error" &&
		model !== undefined &&
		(model.api === "google-generative-ai" || model.api === "google-vertex") &&
		/(multiple tools|combining.*tools|tools.*combination|tool use with function calling is unsupported)/i.test(
			message.errorMessage ?? "",
		)
	) {
		return "server search request rejected (mixed tools unsupported)";
	}
	if (
		message.stopReason === "error" &&
		/(web_search_\d{8}|web_search_preview|openrouter:web_search|googleSearch|google_search|(?:tool(?:[_ -]?type)?|type)\s*[:=]?\s*["']?web_search\b)/i.test(
			message.errorMessage ?? "",
		)
	) {
		const status = message.errorMessage?.match(/\b(400|403|429|500|502|503)\b/)?.[1];
		return `server search request rejected${status ? ` (HTTP ${status})` : ""}`;
	}
	return undefined;
}
