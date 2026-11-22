import type { BetaContentBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";

const replayableTypes: ReadonlySet<string> = new Set([
	"server_tool_use",
	"web_search_tool_result",
	// GLM's Anthropic-compatible coding endpoint returns this server-result shape.
	// Pairing still requires a preceding same-model server_tool_use.
	"tool_result",
	"web_fetch_tool_result",
	"code_execution_tool_result",
	"bash_code_execution_tool_result",
	"text_editor_code_execution_tool_result",
	"tool_search_tool_result",
	"container_upload",
	// Stored fallback markers are audit metadata, not valid Messages input tags.
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

export function isReplayableAnthropicProviderNativeBlock(raw: unknown): raw is BetaContentBlockParam {
	return isRecord(raw) && typeof raw.type === "string" && replayableTypes.has(raw.type);
}

export function isAnthropicWebSearchReplayBlock(raw: unknown): boolean {
	if (!isRecord(raw)) return false;
	if (raw.type === "web_search_tool_result" || raw.type === "tool_result") return true;
	return raw.type === "server_tool_use" && raw.name === "web_search";
}
