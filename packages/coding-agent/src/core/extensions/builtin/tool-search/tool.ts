import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../../types.ts";
import type { Bm25Result } from "./engine/bm25.ts";
import type { ToolSearchSource } from "./engine/document.ts";
import { emitActivationMarker } from "./engine/marker.ts";
import type { ToolSearchService } from "./service.ts";

export const TOOL_SEARCH_TOOL_NAME = "tool_search";
const MAX_RESULTS = 10;

const ParamsSchema = Type.Object({
	query: Type.String({ description: "Natural-language description of the capability you need." }),
	source: Type.Optional(
		Type.Union([Type.Literal("mcp"), Type.Literal("extension")], {
			description: "Optional: restrict the search to MCP or extension tools.",
		}),
	),
	group: Type.Optional(Type.String({ description: "Optional: restrict the search to one catalog group." })),
});
type Params = Static<typeof ParamsSchema>;

export interface ToolSearchDetails {
	query: string;
	activated: string[];
}

type ToolSearchTool = ToolDefinition<typeof ParamsSchema, ToolSearchDetails, unknown>;

/** Author the single shared tool-search definition registered by this builtin. */
export function createToolSearchTool(service: ToolSearchService): ToolSearchTool {
	return {
		name: TOOL_SEARCH_TOOL_NAME,
		label: "Tool search",
		description:
			"Search the catalog of available tools by capability; matched tools are activated and become callable on your NEXT turn.",
		promptSnippet: "Search available tool catalogs by capability; matched tools activate next turn.",
		parameters: ParamsSchema,
		prepareArguments: prepareToolSearchArguments,
		executionMode: "parallel",
		async execute(_toolCallId, params): Promise<AgentToolResult<ToolSearchDetails>> {
			const options = {
				...(params.source === undefined ? {} : { source: params.source }),
				...(params.group === undefined ? {} : { group: params.group }),
			};
			const matches = service.search(params.query, MAX_RESULTS, options);
			const activated = service.activate(matches);
			return {
				content: [
					{ type: "text", text: buildToolSearchResultText(params.query, matches, params.source, params.group) },
				],
				details: { activated, query: params.query },
			};
		},
		renderCall(args, theme) {
			const source = args.source === undefined ? "" : ` source:${args.source}`;
			const group = args.group === undefined ? "" : ` @${args.group}`;
			return new Text(
				theme.fg("toolTitle", theme.bold(`${TOOL_SEARCH_TOOL_NAME} "${args.query}"${source}${group}`)),
				0,
				0,
			);
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

function prepareToolSearchArguments(args: unknown): Params {
	if (!isRecord(args)) return args as Params;
	const { server, ...rest } = args;
	return {
		...rest,
		...(rest.source === undefined && server === undefined ? {} : { source: rest.source ?? "mcp" }),
		...(rest.group === undefined && server === undefined ? {} : { group: rest.group ?? server }),
	} as Params;
}

export function buildToolSearchResultText(
	query: string,
	matches: readonly Bm25Result[],
	source: ToolSearchSource | undefined,
	group: string | undefined,
): string {
	const scope = [
		source === undefined ? undefined : `source "${source}"`,
		group === undefined ? undefined : `group "${group}"`,
	]
		.filter((part): part is string => part !== undefined)
		.join(" in ");
	const scopeText = scope.length === 0 ? "" : ` in ${scope}`;
	if (matches.length === 0) {
		return `No tools matched "${query}"${scopeText}. No tools were activated; try different keywords or run tool_search with a broader query. Your active tool set is unchanged.`;
	}
	const bullets = matches
		.map((match) => `- ${match.name} — ${oneLine(match.doc.description) ?? "(no description)"}`)
		.join("\n");
	const marker = emitActivationMarker(
		matches.map((match) => ({ name: match.name, registrationId: match.doc.registrationId })),
	);
	return [
		`Found ${matches.length} tool(s) matching "${query}"${scopeText}. Matched tools are now active and callable from your NEXT turn:`,
		"",
		bullets,
		"",
		marker,
	].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneLine(text: string | undefined): string | undefined {
	if (text === undefined) return undefined;
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length === 0) return undefined;
	return collapsed.length <= 100 ? collapsed : `${collapsed.slice(0, 97)}...`;
}
