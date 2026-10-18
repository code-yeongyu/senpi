import type { Tool as OpenAITool, ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import type { Api, Model, OpenAIResponsesCompat, TranscriptContext } from "../types.ts";
import { isRequestRefusal } from "../utils/tool-choice-fallback.ts";
import { getCurrentTools } from "../utils/transcript.ts";
import {
	convertResponsesTools,
	resolveResponsesDeferredToolsMode,
	resolveResponsesToolPlacement,
} from "./openai-responses-shared.ts";

type AllowedToolReference = { [key: string]: unknown };

export type AllowedToolsTarget = Pick<Model<Api>, "api" | "provider" | "baseUrl" | "id">;

/**
 * Models whose endpoint refused `tool_choice: allowed_tools` and then accepted the same request
 * restricted to the active tools, for the life of the process (senpi#3080).
 */
const allowedToolsRefusals = new Set<string>();

function refusalKey(target: AllowedToolsTarget): string {
	return JSON.stringify([target.api, target.provider, target.baseUrl, target.id]);
}

export function hasRefusedAllowedToolsChoice(target: AllowedToolsTarget): boolean {
	return allowedToolsRefusals.has(refusalKey(target));
}

export function rememberAllowedToolsChoiceRefusal(target: AllowedToolsTarget): void {
	allowedToolsRefusals.add(refusalKey(target));
}

export function clearAllowedToolsChoiceRefusals(): void {
	allowedToolsRefusals.clear();
}

function allowedReference(tool: OpenAITool): AllowedToolReference {
	if (tool.type === "function" || tool.type === "custom") return { type: tool.type, name: tool.name };
	if (tool.type === "mcp") return { type: "mcp", server_label: tool.server_label };
	return { type: tool.type };
}

function allowedToolsChoice(params: { readonly tool_choice?: unknown }): readonly AllowedToolReference[] | undefined {
	const choice = params.tool_choice;
	if (typeof choice !== "object" || choice === null) return undefined;
	const { type, tools } = choice as { type?: unknown; tools?: unknown };
	return type === "allowed_tools" && Array.isArray(tools) ? (tools as AllowedToolReference[]) : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * A refusal of `allowed_tools` as a `tool_choice` type, sent to a request that carried one. Over HTTP it is
 * a 400; a WebSocket error event before any content carries no status, so the caller vouches for it with
 * `beforeContent`. Observed on a Responses-compatible gateway: "Invalid value: 'allowed_tools'. Supported
 * values are: ..." with param `tool_choice.type`.
 */
export function isAllowedToolsChoiceRefusal(
	error: unknown,
	params: { readonly tool_choice?: unknown },
	options: { readonly beforeContent?: boolean } = {},
): boolean {
	if (allowedToolsChoice(params) === undefined) return false;
	if (!options.beforeContent && !isRequestRefusal(error)) return false;
	const message = errorMessage(error);
	return /\ballowed_tools\b/.test(message) && /invalid|unsupported|not\s+supported/i.test(message);
}

/**
 * The pre-senpi#2095 request shape for an `allowed_tools` request: top-level function and custom tools
 * outside the allowed list leave `tools`, hosted tools stay, and `tool_choice` goes. Tools that transcript
 * items load in place are not filtered; a call to an inactive one is still refused by the session's active
 * tool set. Any other request is unchanged.
 */
export function restrictToAllowedTools<TParams extends ResponseCreateParamsStreaming>(params: TParams): TParams {
	const allowed = allowedToolsChoice(params);
	if (allowed === undefined) return params;
	const allowedNames = new Set(allowed.map((tool) => tool.name).filter((name) => typeof name === "string"));
	const tools = (params.tools ?? []).filter(
		(tool) => (tool.type !== "function" && tool.type !== "custom") || allowedNames.has(tool.name),
	);
	const restricted = { ...params, tools };
	delete restricted.tool_choice;
	return restricted;
}

/**
 * senpi#2095: `tools` carries every tool declared this session, so removing a tool never rewrites the
 * cached prefix; the callable subset rides `tool_choice: allowed_tools` instead. Hosted tools a payload
 * hook added stay callable, and deferred tools (declared by transcript items rather than `tools`) are
 * referenced by name. A declared tool a payload hook removed from `tools` is not referenced (senpi#2234).
 * An empty subset forbids tool calls. An explicit `tool_choice` always wins.
 */
export function applyAllowedToolsChoice<TParams extends ResponseCreateParamsStreaming>(
	params: TParams,
	context: TranscriptContext,
	activeToolNames: readonly string[] | undefined,
	compat: Required<OpenAIResponsesCompat>,
): TParams {
	if (!compat.supportsAllowedTools || activeToolNames === undefined || params.tool_choice !== undefined) {
		return params;
	}
	const active = new Set(activeToolNames);
	const declaredTools = getCurrentTools(context.messages);
	if (declaredTools.every((tool) => active.has(tool.name))) return params;

	const allowed: AllowedToolReference[] = [];
	const namedInTools = new Set<string>();
	for (const tool of params.tools ?? []) {
		if (tool.type === "function" || tool.type === "custom") {
			namedInTools.add(tool.name);
			if (!active.has(tool.name)) continue;
		}
		allowed.push(allowedReference(tool));
	}
	// Tools missing from the request-level `tools` placement are the ones transcript items load in place.
	const requestToolNames = new Set(
		resolveResponsesToolPlacement(
			context.messages,
			resolveResponsesDeferredToolsMode(compat) !== undefined,
		).requestTools.map((tool) => tool.name),
	);
	for (const tool of declaredTools) {
		if (namedInTools.has(tool.name) || !active.has(tool.name) || requestToolNames.has(tool.name)) continue;
		const [converted] = convertResponsesTools([tool], {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		});
		if (converted) allowed.push(allowedReference(converted));
	}

	const toolChoice: ResponseCreateParamsStreaming["tool_choice"] =
		allowed.length > 0 ? { type: "allowed_tools", mode: "auto", tools: allowed } : "none";
	return { ...params, tool_choice: toolChoice };
}
