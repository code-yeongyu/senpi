import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../../types.ts";
import type { Bm25Result } from "./engine/bm25.ts";
import type { ToolSearchSource } from "./engine/document.ts";
import type { HiddenToolHint, ToolSearchService } from "./service.ts";

export const TOOL_SEARCH_TOOL_NAME = "tool_search";
const MAX_RESULTS = 5;

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
	readonly query: string;
	readonly matched: readonly string[];
}

/** Everything the result text needs beyond the ranked matches. */
export interface ToolSearchResultInput {
	readonly query: string;
	readonly matches: readonly Bm25Result[];
	readonly hiddenHints: readonly HiddenToolHint[];
	readonly source: ToolSearchSource | undefined;
	readonly group: string | undefined;
	readonly parametersOf: (name: string) => unknown;
}

type ToolSearchTool = ToolDefinition<typeof ParamsSchema, ToolSearchDetails, unknown>;

/** Author the single shared tool-search definition registered by this builtin. */
export function createToolSearchTool(service: ToolSearchService): ToolSearchTool {
	return {
		name: TOOL_SEARCH_TOOL_NAME,
		label: "Tool search",
		description:
			"Search the catalog of deferred tools by capability. Returns matching tool names with their parameter schemas and never changes your active tool set; call a returned tool by name and it activates on that first call.",
		promptSnippet: "Search deferred tool catalogs by capability; call a returned tool by name to use it.",
		parameters: ParamsSchema,
		prepareArguments: prepareToolSearchArguments,
		executionMode: "parallel",
		async execute(_toolCallId, params): Promise<AgentToolResult<ToolSearchDetails>> {
			const options = {
				...(params.source === undefined ? {} : { source: params.source }),
				...(params.group === undefined ? {} : { group: params.group }),
			};
			const matches = service.search(params.query, MAX_RESULTS, options);
			const text = buildToolSearchResultText({
				group: params.group,
				hiddenHints: service.hiddenToolHints(params.query),
				matches,
				parametersOf: (name) => service.getToolParameters(name),
				query: params.query,
				source: params.source,
			});
			return {
				content: [{ type: "text", text }],
				details: { matched: matches.map((match) => match.name), query: params.query },
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
			const count = result.details?.matched.length ?? 0;
			const title = options.isPartial
				? `${TOOL_SEARCH_TOOL_NAME}: searching`
				: `${TOOL_SEARCH_TOOL_NAME}: ${count} tool(s) found`;
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

export function buildToolSearchResultText(input: ToolSearchResultInput): string {
	const { query, matches, hiddenHints, source, group } = input;
	const scope = [
		source === undefined ? undefined : `source "${source}"`,
		group === undefined ? undefined : `group "${group}"`,
	]
		.filter((part): part is string => part !== undefined)
		.join(" in ");
	const scopeText = scope.length === 0 ? "" : ` in ${scope}`;
	const hintLines = hiddenHints.map((entry) => `- ${entry.name}: ${entry.hint}`);
	if (matches.length === 0) {
		const head = `No catalog tools matched "${query}"${scopeText}. Your active tool set is unchanged.`;
		if (hintLines.length === 0) {
			return `${head} Try different keywords or a broader query.`;
		}
		return [head, "", "The query names a tool that is hidden in this session:", ...hintLines].join("\n");
	}
	const bullets = matches.map((match) => {
		const description = oneLine(match.doc.description) ?? "(no description)";
		const parameters = compactParameters(input.parametersOf(match.name));
		return parameters === undefined
			? `- ${match.name} — ${description}`
			: `- ${match.name} — ${description}\n  parameters: ${parameters}`;
	});
	const lines = [
		`Found ${matches.length} tool(s) matching "${query}"${scopeText}. Nothing was activated; call one by name and it activates on that first call:`,
		"",
		...bullets,
	];
	if (hintLines.length > 0)
		lines.push("", "The query also names a tool that is hidden in this session:", ...hintLines);
	return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneLine(text: string | undefined): string | undefined {
	if (text === undefined) return undefined;
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length === 0) return undefined;
	return collapsed.length <= 160 ? collapsed : `${collapsed.slice(0, 157)}...`;
}

/** One-line JSON schema so the model can call the tool without a second round trip. */
function compactParameters(parameters: unknown): string | undefined {
	if (!isRecord(parameters)) return undefined;
	try {
		return JSON.stringify(parameters);
	} catch (error) {
		if (error instanceof TypeError) return undefined;
		throw error;
	}
}
