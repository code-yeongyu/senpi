import type {
	BetaContentBlockParam as ContentBlockParam,
	MessageCreateParamsStreaming,
	BetaMessageParam as MessageParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { resolveToolNameMatch } from "../utils/tool-name-match.ts";
import { demotedToolCallText, demotedToolResultText } from "../utils/unavailable-tool-text.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Anthropic validates that every tool referenced by the message history is
 * available in the same request — defined in `tools` or discovered through a
 * `tool_reference` block — and rejects the whole request otherwise
 * ("Tool reference '<name>' not found in available tools"). Sessions outlive
 * their tools: an MCP server can be absent after a resume, an extension can
 * stop registering a tool, or a payload hook can strip a definition while the
 * history still carries the call. Demote those references to plain text so
 * the turn can proceed; the matching tool_result is demoted in lockstep so no
 * orphan pairing error replaces the original one.
 *
 * Availability is decided by the request's `tools` array alone. A discovered
 * name never stands in for a missing definition: a `tool_reference` without a
 * definition is itself rejected, so it cannot keep a later `tool_use` alive.
 *
 * Native tool search results (`tool_search_tool_result`) replay verbatim on the
 * same model, and the wire path can hand their references back under a gateway
 * namespace (`mcp__<id>__<tool>`) that senpi never defined and that does not
 * survive across requests. Those references are folded back to the request's
 * own tool names; a reference that still does not resolve is dropped, and a
 * search pair left with no references is demoted to text.
 *
 * The same wire path can also recase the tool it namespaces (`memory` comes
 * back as `mcp__a4e6__Memory`, `lsp_symbols` as `mcp__a4e6__LspSymbols`), so
 * the suffix alone no longer matches the request's tool name byte for byte.
 * Names are therefore resolved by the shared lenient matcher
 * (`utils/tool-name-match.ts`, also used by the inbound tool-call resolver):
 * case and `_`/`-` folded away, an `mcp_`/`mcp__` prefix stripped on either
 * side, and a name resolves only when exactly one request tool matches.
 */
function collectAvailableToolNames(tools: unknown): ReadonlySet<string> {
	const defined = new Set<string>();
	if (Array.isArray(tools)) {
		for (const tool of tools) {
			if (isRecord(tool) && typeof tool.name === "string") defined.add(tool.name);
		}
	}
	return defined;
}

function isNativeToolSearchResultBlock(block: unknown): block is Record<string, unknown> & {
	type: "tool_search_tool_result";
	tool_use_id: string;
	content: Record<string, unknown> & { tool_references: unknown[] };
} {
	return (
		isRecord(block) &&
		block.type === "tool_search_tool_result" &&
		typeof block.tool_use_id === "string" &&
		isRecord(block.content) &&
		Array.isArray(block.content.tool_references)
	);
}

export function demoteUnavailableToolReferences(params: MessageCreateParamsStreaming): MessageCreateParamsStreaming {
	const messages = params.messages;
	if (!Array.isArray(messages) || messages.length === 0) return params;

	const available = collectAvailableToolNames(params.tools);
	const resolve = (name: string): string | undefined => resolveToolNameMatch(name, available);

	const demotedCallNames = new Map<string, string>();
	const renamedCallNames = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (!isRecord(block) || block.type !== "tool_use" || typeof block.name !== "string") continue;
			const resolved = resolve(block.name);
			if (resolved === undefined) demotedCallNames.set(block.id, block.name);
			else if (resolved !== block.name) renamedCallNames.set(block.id, resolved);
		}
	}

	let changed = false;
	const availableToolNames = [...available];
	// A native search pair whose every reference stopped resolving is demoted as a
	// unit: the result decides, and its `server_tool_use` follows. The pair can span
	// two assistant messages (a deferred server tool resumes in the continuation), so
	// the decision is collected over the whole request before any message is rewritten.
	const droppedSearchUseIds = new Set<string>();
	const droppedSearchNames = new Map<string, string[]>();
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (!isNativeToolSearchResultBlock(block)) continue;
			const names = block.content.tool_references
				.filter((item): item is Record<string, unknown> => isRecord(item) && item.type === "tool_reference")
				.map((item) => (typeof item.tool_name === "string" ? item.tool_name : ""));
			if (names.length > 0 && names.every((name) => resolve(name) === undefined)) {
				droppedSearchUseIds.add(block.tool_use_id);
				droppedSearchNames.set(block.tool_use_id, names);
			}
		}
	}

	const seenDemotedCallNames = new Set<string>();
	const rewrittenMessages: MessageParam[] = [];
	for (const message of messages) {
		if (!Array.isArray(message.content)) {
			rewrittenMessages.push(message);
			continue;
		}
		let messageChanged = false;
		const content: ContentBlockParam[] = [];
		for (const block of message.content) {
			if (message.role === "assistant" && isRecord(block) && block.type === "tool_use") {
				const demotedName = demotedCallNames.get(block.id);
				if (demotedName !== undefined) {
					messageChanged = true;
					const firstOccurrence = !seenDemotedCallNames.has(demotedName);
					seenDemotedCallNames.add(demotedName);
					content.push({
						type: "text",
						text: demotedToolCallText(demotedName, availableToolNames, firstOccurrence),
					});
					continue;
				}
				const renamedName = renamedCallNames.get(block.id);
				if (renamedName !== undefined) {
					messageChanged = true;
					content.push({ ...block, name: renamedName } as ContentBlockParam);
					continue;
				}
			}
			if (message.role === "assistant" && isRecord(block) && block.type === "server_tool_use") {
				if (typeof block.id === "string" && droppedSearchUseIds.has(block.id)) {
					messageChanged = true;
					continue;
				}
			}
			if (message.role === "assistant" && isNativeToolSearchResultBlock(block)) {
				const omitted = droppedSearchNames.get(block.tool_use_id);
				if (omitted !== undefined) {
					messageChanged = true;
					content.push({ type: "text", text: `Tool reference unavailable: ${[...new Set(omitted)].join(", ")}` });
					continue;
				}
				const rewritten = rewriteToolReferenceItems(block.content.tool_references, resolve);
				if (rewritten !== undefined) {
					messageChanged = true;
					content.push({
						...block,
						content: { ...block.content, tool_references: rewritten.kept },
					} as ContentBlockParam);
					continue;
				}
			}
			if (isRecord(block) && block.type === "tool_result") {
				const demotedName = demotedCallNames.get(block.tool_use_id);
				if (demotedName !== undefined) {
					messageChanged = true;
					content.push({ type: "text", text: demotedToolResultText(demotedName, toolResultText(block.content)) });
					continue;
				}
				if (Array.isArray(block.content)) {
					const rewritten = rewriteToolReferenceItems(block.content, resolve);
					if (rewritten !== undefined) {
						messageChanged = true;
						const nextContent =
							rewritten.kept.length > 0
								? rewritten.kept
								: [
										{
											type: "text",
											text: `Tool reference unavailable: ${[...new Set(rewritten.omitted)].join(", ")}`,
										},
									];
						content.push({ ...block, content: nextContent } as ContentBlockParam);
						continue;
					}
				}
			}
			content.push(block);
		}
		// Only a message this pass emptied is dropped; a message that arrived empty (a per-message
		// effort marker carries `content: []` by design) passes through untouched (senpi#2912).
		if (messageChanged && content.length === 0) {
			changed = true;
			continue;
		}
		if (messageChanged) {
			changed = true;
			rewrittenMessages.push({ ...message, content });
			continue;
		}
		rewrittenMessages.push(message);
	}

	if (!changed) return params;
	return { ...params, messages: rewrittenMessages };
}

/**
 * Some Anthropic-compatible endpoints run a native tool search inside one request
 * but reject every `tool_reference` replayed from history once the request
 * carries more than a handful of tools: "Tool reference '<name>' not found in
 * available tools" even though `tools` defines the name (senpi #2568). The
 * request is then retried with the replay demoted to text: a native search pair
 * (`server_tool_use` plus its `tool_search_tool_result`, which may sit in a later
 * assistant message) becomes a note naming the tools it found, and
 * `tool_reference` items inside a client `tool_result` become one text item.
 * A deferred tool is loaded only by a replayed reference, so every tool the demoted
 * references named is sent without `defer_loading`: it stays callable without another
 * search. Returns `params` unchanged when the history replays no reference.
 */
export function demoteToolReferenceReplay(params: MessageCreateParamsStreaming): MessageCreateParamsStreaming {
	const messages = params.messages;
	if (!Array.isArray(messages) || messages.length === 0) return params;

	const searchUseIds = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (isRecord(block) && block.type === "tool_search_tool_result" && typeof block.tool_use_id === "string") {
				searchUseIds.add(block.tool_use_id);
			}
		}
	}

	let changed = false;
	const demotedNames = new Set<string>();
	const rewrittenMessages: MessageParam[] = [];
	for (const message of messages) {
		if (!Array.isArray(message.content)) {
			rewrittenMessages.push(message);
			continue;
		}
		let messageChanged = false;
		const content: ContentBlockParam[] = [];
		for (const block of message.content) {
			if (message.role === "assistant" && isRecord(block)) {
				if (block.type === "server_tool_use" && typeof block.id === "string" && searchUseIds.has(block.id)) {
					messageChanged = true;
					continue;
				}
				if (block.type === "tool_search_tool_result") {
					messageChanged = true;
					const names = isNativeToolSearchResultBlock(block)
						? toolReferenceNames(block.content.tool_references)
						: [];
					for (const name of names) demotedNames.add(name);
					content.push({
						type: "text",
						text: names.length > 0 ? `Tool search found: ${names.join(", ")}` : "Tool search found no tools.",
					});
					continue;
				}
			}
			if (isRecord(block) && block.type === "tool_result" && Array.isArray(block.content)) {
				const names = toolReferenceNames(block.content);
				if (names.length > 0) {
					messageChanged = true;
					for (const name of names) demotedNames.add(name);
					const kept = block.content.filter((item) => !(isRecord(item) && item.type === "tool_reference"));
					content.push({
						...block,
						content: [...kept, { type: "text", text: `Tools loaded: ${names.join(", ")}` }],
					} as ContentBlockParam);
					continue;
				}
			}
			content.push(block);
		}
		if (!messageChanged) {
			rewrittenMessages.push(message);
			continue;
		}
		changed = true;
		if (content.length > 0) rewrittenMessages.push({ ...message, content });
	}

	if (!changed) return params;
	return { ...params, messages: rewrittenMessages, ...residentTools(params.tools, demotedNames) };
}

/** Drops `defer_loading` from the tools a demoted reference named; the rest keep their deferral. */
function residentTools(
	tools: MessageCreateParamsStreaming["tools"],
	names: ReadonlySet<string>,
): Pick<MessageCreateParamsStreaming, "tools"> | Record<string, never> {
	if (!Array.isArray(tools) || names.size === 0) return {};
	let changed = false;
	const rewritten = tools.map((tool) => {
		if (!isRecord(tool) || tool.defer_loading !== true || typeof tool.name !== "string" || !names.has(tool.name))
			return tool;
		changed = true;
		const { defer_loading: _deferLoading, ...resident } = tool;
		return resident as typeof tool;
	});
	return changed ? { tools: rewritten } : {};
}

function toolReferenceNames(items: readonly unknown[]): string[] {
	const names = new Set<string>();
	for (const item of items) {
		if (isRecord(item) && item.type === "tool_reference" && typeof item.tool_name === "string")
			names.add(item.tool_name);
	}
	return [...names];
}

/**
 * Folds every `tool_reference` item in `items` onto the request's own tool
 * name and drops the ones that still do not resolve. Returns undefined when
 * nothing changed so callers can keep the original block identity.
 */
function rewriteToolReferenceItems(
	items: readonly unknown[],
	resolve: (name: string) => string | undefined,
): { kept: unknown[]; omitted: string[] } | undefined {
	const kept: unknown[] = [];
	const omitted: string[] = [];
	let rewritten = false;
	for (const item of items) {
		if (!isRecord(item) || item.type !== "tool_reference" || typeof item.tool_name !== "string") {
			kept.push(item);
			continue;
		}
		const resolved = resolve(item.tool_name);
		if (resolved === undefined) {
			omitted.push(item.tool_name);
			rewritten = true;
			continue;
		}
		if (resolved !== item.tool_name) {
			kept.push({ ...item, tool_name: resolved });
			rewritten = true;
			continue;
		}
		kept.push(item);
	}
	return rewritten ? { kept, omitted } : undefined;
}

function toolResultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const item of content) {
			if (!isRecord(item)) continue;
			if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
			else if (typeof item.type === "string") parts.push(`[${item.type}]`);
		}
		if (parts.length > 0) return parts.join("\n");
	}
	return "Tool output unavailable.";
}
