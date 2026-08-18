import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolSearchDocument } from "./engine/document.ts";

// Anthropic Messages supports native BM25 tool search through request payload
// injection alone. OpenAI native client-mode search remains intentionally out of
// scope because it requires a provider-layer seam.

export const ANTHROPIC_TOOL_SEARCH_TYPE = "tool_search_tool_bm25_20251119";
export const ANTHROPIC_TOOL_SEARCH_NAME = "tool_search";
/** Anthropic caps a request at 10k tools; beyond that native search is invalid. */
export const ANTHROPIC_MAX_TOOLS = 10000;

type McpNativeToolSearchGate = () => boolean;

const scopedMcpNativeToolSearchGate = new AsyncLocalStorage<McpNativeToolSearchGate>();
let mcpNativeToolSearchGate: McpNativeToolSearchGate = () => false;

/** Bind the MCP-owned user setting without moving MCP configuration into the shared builtin. */
export function installMcpNativeToolSearchGate(gate: McpNativeToolSearchGate): void {
	mcpNativeToolSearchGate = gate;
	scopedMcpNativeToolSearchGate.enterWith(gate);
}

export function isMcpNativeToolSearchEnabled(): boolean {
	return (scopedMcpNativeToolSearchGate.getStore() ?? mcpNativeToolSearchGate)();
}

export interface NativeToolDefinition {
	readonly description?: string;
	readonly parameters?: unknown;
}

export interface AnthropicNativeInjectionConfig {
	/** Never defer this tool (our custom tool_search), and it is non-deferrable. */
	readonly searchToolName?: string;
	/** True only for catalog tools eligible for native deferral in this request. */
	readonly isDeferrable: (toolName: string) => boolean;
	/** Current searchable catalog. Omit when only transforming resident tools. */
	readonly getCatalog?: () => readonly ToolSearchDocument[];
	/** Resolve the winning registered definition used to inject inactive schemas. */
	readonly getToolDefinition?: (toolName: string) => NativeToolDefinition | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Pure payload transform. Injects eligible inactive catalog schemas, adds exactly
 * one native search tool, and enforces Anthropic's HARD RULES: never defer the
 * local search tool, never combine defer_loading with cache_control, keep at
 * least one non-deferred tool, and skip entirely above the 10k tool cap.
 */
export function addAnthropicNativeToolSearch(
	api: string | undefined,
	payload: unknown,
	config: AnthropicNativeInjectionConfig,
): unknown {
	if (api !== "anthropic-messages" || !isRecord(payload)) return payload;
	const tools = Array.isArray(payload.tools) ? payload.tools : [];
	const injected = injectInactiveCatalogTools(tools, config);
	if (injected.length > ANTHROPIC_MAX_TOOLS) return payload;
	const deferred = injected.map((tool) => maybeDefer(tool, config));
	const hasSearchTool = deferred.some((tool) => isRecord(tool) && tool.type === ANTHROPIC_TOOL_SEARCH_TYPE);
	const nextTools = hasSearchTool
		? deferred
		: [...deferred, { type: ANTHROPIC_TOOL_SEARCH_TYPE, name: ANTHROPIC_TOOL_SEARCH_NAME }];
	if (nextTools.length > ANTHROPIC_MAX_TOOLS) return payload;
	return { ...payload, tools: nextTools };
}

function injectInactiveCatalogTools(tools: readonly unknown[], config: AnthropicNativeInjectionConfig): unknown[] {
	const catalog = config.getCatalog?.() ?? [];
	const residentNames = new Set(
		tools.flatMap((tool) => (isRecord(tool) && typeof tool.name === "string" ? [tool.name] : [])),
	);
	const injected: unknown[] = [...tools];
	for (const doc of catalog) {
		if (doc.name === config.searchToolName || residentNames.has(doc.name) || !config.isDeferrable(doc.name)) continue;
		const definition = config.getToolDefinition?.(doc.name);
		if (definition?.parameters === undefined) continue;
		injected.push({
			name: doc.name,
			description: definition.description ?? doc.description ?? doc.label,
			input_schema: definition.parameters,
			defer_loading: true,
		});
		residentNames.add(doc.name);
	}
	return injected;
}

function maybeDefer(tool: unknown, config: AnthropicNativeInjectionConfig): unknown {
	if (!isRecord(tool)) return tool;
	const name = typeof tool.name === "string" ? tool.name : undefined;
	if (name === undefined) return tool;
	if (name === config.searchToolName) return tool;
	if (!config.isDeferrable(name)) return tool;
	if ("cache_control" in tool) return tool;
	if (tool.defer_loading === true) return tool;
	return { ...tool, defer_loading: true };
}

/** `tool_reference` blocks emitted inside a tool_result so the API expands the referenced tools. */
export function buildToolReferenceBlocks(names: readonly string[]): { type: "tool_reference"; name: string }[] {
	return names.map((name) => ({ type: "tool_reference", name }));
}

export interface AnthropicNativeAdapterDeps extends AnthropicNativeInjectionConfig {
	/** Resolved provider/config gate. */
	enabled(): boolean;
	/** Invoked once when a 400 forces the local-search fallback. */
	onFallback?(reason: string): void;
}

/** Session-scoped request injector with permanent 400 fallback for the session. */
export class AnthropicNativeToolSearchAdapter {
	#disabled = false;
	#injectedLastRequest = false;
	#fallbackReason: string | null = null;
	readonly #deps: AnthropicNativeAdapterDeps;

	constructor(deps: AnthropicNativeAdapterDeps) {
		this.#deps = deps;
	}

	applyBeforeRequest(api: string | undefined, payload: unknown): unknown {
		this.#injectedLastRequest = false;
		if (this.#disabled || !this.#deps.enabled()) return payload;
		const next = addAnthropicNativeToolSearch(api, payload, this.#deps);
		this.#injectedLastRequest = next !== payload;
		return next;
	}

	noteResponseStatus(status: number): void {
		if (status !== 400 || !this.#injectedLastRequest || this.#disabled) return;
		this.#disabled = true;
		this.#fallbackReason =
			"Anthropic returned 400 for native tool-search; disabled it and fell back to local tool_search for this session.";
		this.#deps.onFallback?.(this.#fallbackReason);
	}

	get disabled(): boolean {
		return this.#disabled;
	}

	get fallbackReason(): string | null {
		return this.#fallbackReason;
	}
}
