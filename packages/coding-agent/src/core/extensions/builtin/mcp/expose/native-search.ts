// Native provider tool-search adapters (todo 33 — Anthropic half).
//
// Gated on the todo-29 spike verdict: Anthropic Messages is GO-pure-extension —
// server_tool_use / tool_search_tool_result blocks round-trip pi-ai's
// parse->persist->re-serialise cycle untouched (native-search-spike.md), so this
// adapter injects request-side fields via the extension before_provider_request
// event ONLY (the sole ExtensionAPI payload surface) with no pi-ai change.
//
// It injects Anthropic's native `tool_search_tool_bm25_20251119` tool and marks
// deferrable MCP tools `defer_loading:true`, honouring the API HARD RULES, and
// auto-falls-back to local Tier-B on a 400. The OpenAI half is deferred
// (spike = GO-with-ai-seam; see native-search-spike.md).

export const ANTHROPIC_TOOL_SEARCH_TYPE = "tool_search_tool_bm25_20251119";
export const ANTHROPIC_TOOL_SEARCH_NAME = "tool_search";
/** Anthropic caps a request at 10k tools; beyond that native search is invalid. */
export const ANTHROPIC_MAX_TOOLS = 10000;

export interface AnthropicNativeInjectionConfig {
	/** Never defer this tool (our custom tool_search), and it is non-deferrable. */
	readonly searchToolName?: string;
	/** True for MCP catalog tools eligible for deferral. */
	readonly isDeferrable: (toolName: string) => boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Pure payload transform. Adds exactly one native tool-search tool (idempotent)
 * and sets `defer_loading:true` on eligible MCP tools, enforcing the HARD RULES:
 * never defer the search tool, never combine defer_loading with cache_control
 * (400), keep >=1 non-deferred tool (the native search tool guarantees this),
 * and skip entirely above the 10k tool cap.
 */
export function addAnthropicNativeToolSearch(
	api: string | undefined,
	payload: unknown,
	config: AnthropicNativeInjectionConfig,
): unknown {
	if (api !== "anthropic-messages" || !isRecord(payload)) return payload;
	const tools = Array.isArray(payload.tools) ? payload.tools : [];
	if (tools.length > ANTHROPIC_MAX_TOOLS) return payload;
	const deferred = tools.map((tool) => maybeDefer(tool, config));
	const hasSearchTool = deferred.some((tool) => isRecord(tool) && tool.type === ANTHROPIC_TOOL_SEARCH_TYPE);
	const nextTools = hasSearchTool
		? deferred
		: [...deferred, { type: ANTHROPIC_TOOL_SEARCH_TYPE, name: ANTHROPIC_TOOL_SEARCH_NAME }];
	return { ...payload, tools: nextTools };
}

function maybeDefer(tool: unknown, config: AnthropicNativeInjectionConfig): unknown {
	if (!isRecord(tool)) return tool;
	const name = typeof tool.name === "string" ? tool.name : undefined;
	if (name === undefined) return tool; // server/native tools are type-based, never deferred
	if (name === config.searchToolName) return tool; // never defer the search tool
	if (!config.isDeferrable(name)) return tool; // non-MCP tools untouched
	if ("cache_control" in tool) return tool; // never defer_loading + cache_control (400)
	if (tool.defer_loading === true) return tool; // idempotent
	return { ...tool, defer_loading: true };
}

/** `tool_reference` blocks emitted inside a tool_result so the API expands the
 * referenced (deferred) tools — the cache-prefix-safe custom-search path. */
export function buildToolReferenceBlocks(names: readonly string[]): { type: "tool_reference"; name: string }[] {
	return names.map((name) => ({ type: "tool_reference", name }));
}

export interface AnthropicNativeAdapterDeps extends AnthropicNativeInjectionConfig {
	/** Resolved config gate (nativeToolSearch auto|true AND provider supports). */
	enabled(): boolean;
	/** Invoked once when a 400 forces the local-search fallback. */
	onFallback?(reason: string): void;
}

/**
 * Stateful adapter driving the before_provider_request injection and the
 * after_provider_response 400 detector. Once a 400 lands on a request we
 * injected, native search is disabled for the rest of the session and the
 * extension falls back to local Tier-B (which is always registered).
 */
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
