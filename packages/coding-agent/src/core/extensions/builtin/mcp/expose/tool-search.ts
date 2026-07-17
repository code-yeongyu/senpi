// tool_search tool + promotion engine (todo 31).
//
// `tool_search` is an always-active tool that ranks the full MCP catalog with
// the local BM25 engine and PROMOTES matched tools into the active set via
// setActiveTools (effective the NEXT turn — senpi semantics). Promotion state
// is derivable from history: each result embeds a stable activation marker so a
// compaction/restart can replay activations at session_start
// (rehydrateActiveToolsFromHistory). Activated tools persist for the session;
// there is no auto-eviction in v1. Every setActiveTools call is stable-sorted.

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../../../types.ts";
import { type Bm25Doc, buildBm25Index } from "./bm25.ts";

export const TOOL_SEARCH_TOOL_NAME = "tool_search";
/** Stable, machine-parseable marker embedded in every activating result so
 * activations survive compaction/restart. Kept human-readable on purpose. */
export const TOOL_SEARCH_ACTIVATION_MARKER = "[tool_search:activated]";
const MAX_RESULTS = 10;

export type SearchableMcpTool = Bm25Doc;

export interface McpSearchDeps {
	/** Full current catalog (all MCP tools, active or not) to rank over. */
	getSearchableTools(): readonly SearchableMcpTool[];
	/** Current active tool names (includes non-MCP tools). */
	getActiveTools(): string[];
	/** Replace the active set. Implementations should preserve registration. */
	setActiveTools(names: readonly string[]): void;
}

export interface McpSearchDetails {
	query: string;
	activated: string[];
}

const ParamsSchema = Type.Object({
	query: Type.String({ description: "Natural-language description of the capability you need." }),
	server: Type.Optional(Type.String({ description: "Optional: restrict the search to a single MCP server name." })),
});
type Params = Static<typeof ParamsSchema>;

type McpSearchTool = ToolDefinition<typeof ParamsSchema, McpSearchDetails, unknown>;

export function createMcpSearchTool(deps: McpSearchDeps): McpSearchTool {
	return {
		name: TOOL_SEARCH_TOOL_NAME,
		label: "MCP tool search",
		description:
			"Search the catalog of available MCP tools by capability. Matched tools are activated and become callable on your NEXT turn. Use this before calling an MCP tool that is not already active.",
		promptSnippet: "Search MCP servers for a tool by capability; matched tools activate next turn.",
		parameters: ParamsSchema,
		executionMode: "parallel",
		async execute(_toolCallId, params: Params): Promise<AgentToolResult<McpSearchDetails>> {
			const searchable = deps.getSearchableTools();
			const index = buildBm25Index(searchable);
			const matches = index.search(params.query, MAX_RESULTS, params.server ? { server: params.server } : {});
			const activated = matches.map((match) => match.name);
			if (activated.length > 0) {
				deps.setActiveTools(unionStable(deps.getActiveTools(), activated));
			}
			const text = buildMcpSearchResultText(params.query, matches, params.server);
			return {
				content: [{ type: "text", text }],
				details: { activated, query: params.query },
			};
		},
		renderCall(args, theme) {
			const filter = args.server ? ` @${args.server}` : "";
			return new Text(theme.fg("toolTitle", theme.bold(`${TOOL_SEARCH_TOOL_NAME} "${args.query}"${filter}`)), 0, 0);
		},
		renderResult(result, options, theme) {
			const count = result.details?.activated.length ?? 0;
			const title = options.isPartial
				? `${TOOL_SEARCH_TOOL_NAME}: searching`
				: `${TOOL_SEARCH_TOOL_NAME}: ${count} tool(s) activated`;
			return new Text(theme.fg("toolOutput", title), 0, 0);
		},
	};
}

interface RankedMatch {
	readonly name: string;
	readonly doc: SearchableMcpTool;
}

export function buildMcpSearchResultText(
	query: string,
	matches: readonly RankedMatch[],
	server: string | undefined,
): string {
	const scope = server ? ` on server "${server}"` : "";
	if (matches.length === 0) {
		return `No MCP tools matched "${query}"${scope}. No tools were activated; try different keywords or run tool_search with a broader query. Your active tool set is unchanged.`;
	}
	const bullets = matches
		.map((match) => `- ${match.name} — ${oneLine(match.doc.description) ?? "(no description)"}`)
		.join("\n");
	const names = matches.map((match) => match.name).join(" ");
	return [
		`Found ${matches.length} MCP tool(s) matching "${query}"${scope}. They are now active and callable from your NEXT turn:`,
		"",
		bullets,
		"",
		`${TOOL_SEARCH_ACTIVATION_MARKER} ${names}`,
	].join("\n");
}

/**
 * Replay tool_search activations recorded in prior history so a
 * compacted/restarted session restores its active tool set without re-searching.
 * Only names still present in `validNames` are restored (removed tools stay
 * dropped). Deterministic: returns a de-duplicated, sorted list.
 */
export function rehydrateActiveToolsFromHistory(
	messages: readonly unknown[],
	validNames: ReadonlySet<string>,
): string[] {
	const restored = new Set<string>();
	for (const message of messages) {
		for (const segment of extractActivationSegments(message)) {
			for (const name of segment.trim().split(/\s+/)) {
				if (name.length > 0 && validNames.has(name)) restored.add(name);
			}
		}
	}
	return [...restored].sort();
}

function extractActivationSegments(message: unknown): string[] {
	let blob: string;
	try {
		blob = JSON.stringify(message) ?? "";
	} catch {
		return [];
	}
	const segments: string[] = [];
	let cursor = blob.indexOf(TOOL_SEARCH_ACTIVATION_MARKER);
	while (cursor >= 0) {
		const rest = blob.slice(cursor + TOOL_SEARCH_ACTIVATION_MARKER.length);
		// Tool names are [a-zA-Z0-9_-]; stop at the first JSON string terminator
		// (quote / escape) or newline so we never swallow the rest of the blob.
		const end = rest.search(/["\\\n]/);
		segments.push(end < 0 ? rest : rest.slice(0, end));
		cursor = blob.indexOf(TOOL_SEARCH_ACTIVATION_MARKER, cursor + TOOL_SEARCH_ACTIVATION_MARKER.length);
	}
	return segments;
}

/** Stable union: dedupe and sort so the active-tools array is byte-stable
 * across turns (prompt-cache friendly). */
export function unionStable(current: readonly string[], added: readonly string[]): string[] {
	return [...new Set([...current, ...added])].sort();
}

function oneLine(text: string | undefined): string | undefined {
	if (text === undefined) return undefined;
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length === 0) return undefined;
	return collapsed.length <= 100 ? collapsed : `${collapsed.slice(0, 97)}...`;
}
