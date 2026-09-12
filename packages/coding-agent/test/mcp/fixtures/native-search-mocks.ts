// Synthetic provider-response mocks for the native tool-search preservation
// spike (todo 29) and the native adapter tests (todos 33/34).
//
// These fixtures never touch a real API. They fabricate the exact response
// shapes the Anthropic Messages API and OpenAI Responses API emit for
// server-side tool-search so we can characterise how pi-ai parses, persists,
// and re-serialises them WITHOUT spending tokens.
//
// The mocks import nothing from the MCP extension runtime — they model the
// provider wire only.

// ---------------------------------------------------------------------------
// Anthropic Messages (SSE) mock
// ---------------------------------------------------------------------------

export interface AnthropicSseOptions {
	readonly messageId?: string;
	readonly contentBlocks: readonly Record<string, unknown>[];
}

/**
 * Build a raw Anthropic Messages SSE transcript. Each content block is emitted
 * as a `content_block_start` immediately followed by a `content_block_stop`,
 * which is exactly how the API frames non-streaming server-tool blocks such as
 * `server_tool_use` and `tool_search_tool_result`.
 */
export function buildAnthropicSse(options: AnthropicSseOptions): string {
	const messageId = options.messageId ?? "msg_spike_1";
	const lines: string[] = [];
	const push = (event: string, data: unknown): void => {
		lines.push(`event: ${event}`, `data: ${JSON.stringify(data)}`, "");
	};

	push("message_start", {
		type: "message_start",
		message: {
			id: messageId,
			type: "message",
			role: "assistant",
			model: "claude-sonnet-4-5",
			content: [],
			stop_reason: null,
			usage: { input_tokens: 10, output_tokens: 0 },
		},
	});
	options.contentBlocks.forEach((block, index) => {
		push("content_block_start", { type: "content_block_start", index, content_block: block });
		push("content_block_stop", { type: "content_block_stop", index });
	});
	push("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } });
	push("message_stop", { type: "message_stop" });
	return lines.join("\n");
}

export interface MockAnthropicClient {
	readonly client: unknown;
	/** Params captured from the most recent `messages.create` call. */
	lastParams(): Record<string, unknown> | undefined;
	createCount(): number;
}

/**
 * Minimal stand-in for the Anthropic SDK client accepted by pi-ai's
 * `stream({ client })`. It records the outgoing request params (so a
 * re-serialisation round-trip can be asserted) and returns a canned SSE body.
 */
export function makeMockAnthropicClient(sse: string): MockAnthropicClient {
	let lastParams: Record<string, unknown> | undefined;
	let createCount = 0;
	const client = {
		beta: {
			messages: {
				create(params: Record<string, unknown>) {
					lastParams = params;
					createCount += 1;
					return {
						asResponse(): Promise<Response> {
							return Promise.resolve(
								new Response(sse, {
									status: 200,
									headers: { "content-type": "text/event-stream" },
								}),
							);
						},
					};
				},
			},
		},
	};
	return {
		client,
		lastParams: () => lastParams,
		createCount: () => createCount,
	};
}

// ---------------------------------------------------------------------------
// OpenAI Responses mock
// ---------------------------------------------------------------------------

/**
 * Build the OpenAI Responses streaming events for a set of output items. Items
 * whose type pi-ai does not natively slot (e.g. `tool_search_call`,
 * `web_search_call`) fall into the providerNative capture path.
 */
export function buildOpenAiResponseEvents(items: readonly Record<string, unknown>[]): Record<string, unknown>[] {
	const events: Record<string, unknown>[] = [{ type: "response.created", response: { id: "resp_spike_1" } }];
	items.forEach((item, index) => {
		events.push({ type: "response.output_item.added", output_index: index, item });
		events.push({ type: "response.output_item.done", output_index: index, item });
	});
	events.push({
		type: "response.completed",
		response: {
			id: "resp_spike_1",
			status: "completed",
			usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
		},
	});
	return events;
}

export async function* asyncIterable<T>(items: readonly T[]): AsyncGenerator<T> {
	for (const item of items) {
		yield item;
	}
}

// ---------------------------------------------------------------------------
// Canonical server-tool blocks (shared by spike + adapter tests)
// ---------------------------------------------------------------------------

/** Anthropic `server_tool_use` block referencing a tool-search invocation. */
export function anthropicServerToolUseBlock(id = "srvtoolu_spike_1"): Record<string, unknown> {
	return {
		type: "server_tool_use",
		id,
		name: "tool_search",
		input: { query: "library docs" },
	};
}

/** Anthropic `tool_search_tool_result` block carrying tool_reference entries. */
export function anthropicToolSearchResultBlock(toolUseId = "srvtoolu_spike_1"): Record<string, unknown> {
	return {
		type: "tool_search_tool_result",
		tool_use_id: toolUseId,
		content: [
			{ type: "tool_reference", name: "mcp_docs_get-library-docs" },
			{ type: "tool_reference", name: "mcp_docs_resolve-library-id" },
		],
	};
}

// ---------------------------------------------------------------------------
// Anthropic REQUEST-side validator (todo 33) — mimics the API's tool-search
// constraint checks and returns a 400 on violation, exactly as the real API
// would, so the adapter's HARD RULES can be exercised without a real call.
// ---------------------------------------------------------------------------

export const ANTHROPIC_TOOL_SEARCH_TYPE = "tool_search_tool_bm25_20251119";
/** The API validates the server tool's `name` against its variant: `tools.N.<type>.name: Input should be '<name>'`. */
export const ANTHROPIC_TOOL_SEARCH_CONTRACT_NAME = "tool_search_tool_bm25";

export interface AnthropicValidationResult {
	readonly status: 200 | 400;
	readonly error?: string;
}

function isObj(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function validateAnthropicToolSearchPayload(payload: unknown): AnthropicValidationResult {
	if (!isObj(payload)) return { status: 200 };
	const tools = Array.isArray(payload.tools) ? payload.tools : [];
	if (tools.length > 10000) return { status: 400, error: "too_many_tools: at most 10000 tools" };
	const objs = tools.filter(isObj);
	const deferred = objs.filter((tool) => tool.defer_loading === true);
	const hasSearchTool = objs.some((tool) => tool.type === ANTHROPIC_TOOL_SEARCH_TYPE);
	for (const tool of deferred) {
		if ("cache_control" in tool) {
			return { status: 400, error: "invalid_request: defer_loading and cache_control on the same tool" };
		}
		if (tool.type === ANTHROPIC_TOOL_SEARCH_TYPE) {
			return { status: 400, error: "invalid_request: the tool-search tool cannot be deferred" };
		}
	}
	if (deferred.length > 0 && !hasSearchTool) {
		return { status: 400, error: "invalid_request: deferred tools require a tool_search tool" };
	}
	if (objs.length > 0 && deferred.length === objs.length) {
		return { status: 400, error: "invalid_request: at least one tool must be non-deferred" };
	}
	// The API validates the server tool's `name` against its variant; a `name`-less
	// stub is tolerated here so shape-only fixtures stay valid.
	const misnamed = objs.findIndex(
		(tool) =>
			tool.type === ANTHROPIC_TOOL_SEARCH_TYPE &&
			"name" in tool &&
			tool.name !== ANTHROPIC_TOOL_SEARCH_CONTRACT_NAME,
	);
	if (misnamed >= 0) {
		return {
			status: 400,
			error: `invalid_request_error: tools.${misnamed}.${ANTHROPIC_TOOL_SEARCH_TYPE}.name: Input should be '${ANTHROPIC_TOOL_SEARCH_CONTRACT_NAME}'`,
		};
	}
	return { status: 200 };
}

/** Simulate the API expanding `tool_reference` blocks inside a tool_result into
 * the concrete tool names it will surface next turn. */
export function mockAnthropicExpandToolReferences(block: unknown): string[] {
	if (!isObj(block) || !Array.isArray(block.content)) return [];
	return block.content
		.filter((entry): entry is Record<string, unknown> => isObj(entry) && entry.type === "tool_reference")
		.map((entry) => String(entry.tool_name));
}

/** OpenAI `tool_search_call` output item (client-mode intercept target). */
export function openAiToolSearchCallItem(id = "ts_spike_1"): Record<string, unknown> {
	return {
		type: "tool_search_call",
		id,
		status: "completed",
		queries: ["library docs"],
	};
}
