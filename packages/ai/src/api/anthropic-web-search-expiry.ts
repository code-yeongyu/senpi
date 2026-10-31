import type {
	BetaContentBlockParam as ContentBlockParam,
	MessageCreateParamsStreaming,
	BetaMessageParam as MessageParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";

/**
 * The opaque `encrypted_content` of a native web search result is only valid
 * for the account that ran the search (senpi #3201). Same-model replay keeps
 * the payload byte-for-byte (#208), so once a request is served by another
 * account (credential rotation, a multi-account gateway) every later request
 * on that model fails with "messages.N.content.0: Invalid `encrypted_content` in
 * `search_result` block" and the session only moves on through a model
 * fallback. Stripping the field is not an option: the API requires it (#150).
 *
 * Recovery demotes expired search pairs to plain text: the `server_tool_use`
 * becomes a note naming its query and the `web_search_tool_result` a list of
 * the result titles and URLs. Only pairs whose result sits at or before the
 * rejected message are demoted, because a search is never fresher than a
 * later one; newer results keep replaying verbatim.
 */

const EXPIRED_SEARCH_CONTENT = /Invalid `encrypted_content` in `search_result` block/i;
const REJECTED_MESSAGE_INDEX = /messages\.(\d+)\.content\.\d+: Invalid `encrypted_content`/i;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function isExpiredWebSearchContentError(error: unknown): error is Error {
	return (
		error instanceof Error &&
		"status" in error &&
		(error as { status?: unknown }).status === 400 &&
		EXPIRED_SEARCH_CONTENT.test(error.message)
	);
}

function webSearchResultIds(message: MessageParam): string[] {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
	const ids: string[] = [];
	for (const block of message.content) {
		if (isRecord(block) && block.type === "web_search_tool_result" && typeof block.tool_use_id === "string") {
			ids.push(block.tool_use_id);
		}
	}
	return ids;
}

/**
 * The `tool_use_id`s of the web search results the rejected request replayed
 * at or before the message the API named. Without a parsable index every
 * replayed result counts as expired.
 */
export function expiredWebSearchReplayIds(params: MessageCreateParamsStreaming, error: Error): string[] {
	const match = REJECTED_MESSAGE_INDEX.exec(error.message);
	const lastIndex = match?.[1] === undefined ? params.messages.length - 1 : Number(match[1]);
	return params.messages.slice(0, lastIndex + 1).flatMap(webSearchResultIds);
}

function searchQuery(block: Record<string, unknown>): string | undefined {
	const input = block.input;
	return isRecord(input) && typeof input.query === "string" ? input.query : undefined;
}

function demotedResultText(block: Record<string, unknown>): string {
	const results = Array.isArray(block.content) ? block.content : [];
	const lines: string[] = [];
	for (const result of results) {
		if (!isRecord(result) || result.type !== "web_search_result") continue;
		const title = typeof result.title === "string" ? result.title : "";
		const url = typeof result.url === "string" ? result.url : "";
		lines.push(`- ${title} (${url})`);
	}
	if (lines.length === 0) return "Web search returned no results.";
	return ["Web search results (page contents no longer available):", ...lines].join("\n");
}

function demoteBlock(block: ContentBlockParam, expired: ReadonlySet<string>): ContentBlockParam | undefined {
	if (!isRecord(block)) return undefined;
	if (block.type === "server_tool_use" && block.name === "web_search" && typeof block.id === "string") {
		if (!expired.has(block.id)) return undefined;
		const query = searchQuery(block);
		return { type: "text", text: query === undefined ? "Searched the web." : `Searched the web for: ${query}` };
	}
	if (block.type === "web_search_tool_result" && typeof block.tool_use_id === "string") {
		if (!expired.has(block.tool_use_id)) return undefined;
		return { type: "text", text: demotedResultText(block) };
	}
	return undefined;
}

export function demoteExpiredWebSearchReplay(
	params: MessageCreateParamsStreaming,
	expired: ReadonlySet<string>,
): MessageCreateParamsStreaming {
	if (expired.size === 0) return params;
	let changed = false;
	const messages = params.messages.map((message): MessageParam => {
		if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
		let messageChanged = false;
		const content = message.content.map((block) => {
			const demoted = demoteBlock(block, expired);
			if (demoted === undefined) return block;
			messageChanged = true;
			return demoted;
		});
		if (!messageChanged) return message;
		changed = true;
		return { ...message, content };
	});
	return changed ? { ...params, messages } : params;
}
