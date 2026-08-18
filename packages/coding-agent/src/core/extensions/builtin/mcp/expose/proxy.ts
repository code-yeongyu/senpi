// Tier-C proxy mode (todo 38): per-server OPT-IN (`exposure:"proxy"`).
//
// The whole server catalog hides behind ONE always-active `mcp_<server>`
// gateway tool with three ops: search (BM25 over this server's catalog),
// describe (schema + description for one tool), call (tool + args as a JSON
// STRING). The JSON-string args deliberately trade provider strict-mode
// validation for a ~200-token footprint (SPEC §5: -27.3pp GSM8K structured
// output under proxy) — which is why auto NEVER selects this mode. Errors are
// returned as guiding text (never thrown for user mistakes) so the model can
// self-correct; unknown tool names get nearest-match suggestions.

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../../../types.ts";
import { buildBm25Index } from "../../tool-search/engine/bm25.ts";
import { deriveMcpRegistrationId } from "../../tool-search/engine/marker.ts";
import type { McpToolCatalogEntry } from "../catalog.ts";
import { executeMcpCatalogEntry, type McpToolDetails, mapMcpCatalogNames } from "./register.ts";

const ParamsSchema = Type.Object({
	op: Type.Union([Type.Literal("search"), Type.Literal("describe"), Type.Literal("call")], {
		description: "search: rank tools by capability; describe: full schema for one tool; call: invoke a tool.",
	}),
	query: Type.Optional(Type.String({ description: "search: capability description to rank tools by." })),
	tool: Type.Optional(Type.String({ description: "describe/call: the server-side tool name." })),
	args: Type.Optional(
		Type.String({
			description: 'call: tool arguments as a JSON object STRING, e.g. "{\\"path\\": \\"a.txt\\"}".',
		}),
	),
});
type Params = Static<typeof ParamsSchema>;

type ProxyResult = AgentToolResult<McpToolDetails | undefined>;
type McpProxyTool = ToolDefinition<typeof ParamsSchema, McpToolDetails | undefined, unknown>;

export function createMcpProxyTool(server: string, entries: readonly McpToolCatalogEntry[]): McpProxyTool {
	const named = mapMcpCatalogNames(entries);
	const byTool = new Map(named.map(({ entry }) => [entry.tool, entry] as const));
	const index = buildBm25Index(
		named.map(({ entry, name }) => ({
			name,
			label: entry.tool,
			aliases: [entry.tool],
			description: entry.description,
			keywords: [],
			source: "mcp" as const,
			group: server,
			ownerLabel: server,
			registrationId: deriveMcpRegistrationId(server, entry.tool),
		})),
	);
	const name = named[0]?.name.split("_").slice(0, 2).join("_") ?? `mcp_${server}`;
	return {
		name,
		label: `MCP proxy for ${server}`,
		description: `Gateway to the '${server}' MCP server (${entries.length} tools). Use op:"search" with a query to find tools, op:"describe" with a tool name for its schema, then op:"call" with tool + args (args is a JSON object STRING — no strict validation, so match the described schema exactly).`,
		promptSnippet: `Proxy for the ${server} MCP server: search -> describe -> call (args as a JSON string).`,
		parameters: ParamsSchema,
		executionMode: "parallel",
		async execute(_toolCallId, params: Params, signal, onUpdate): Promise<ProxyResult> {
			if (params.op === "search") {
				const matches = index.search(params.query ?? "", 10, {});
				const body =
					matches.length === 0
						? `No '${server}' tools matched. Try broader keywords or op:"describe" with an exact tool name.`
						: matches
								.map((match) => `- ${match.doc.label} — ${match.doc.description ?? "(no description)"}`)
								.join("\n");
				return textResult(server, `Tools on '${server}':\n${body}`);
			}
			const entry = params.tool === undefined ? undefined : byTool.get(params.tool);
			if (entry === undefined) {
				return textResult(server, unknownToolText(server, params.tool, index));
			}
			if (params.op === "describe") {
				return textResult(
					server,
					`${entry.tool}: ${entry.description ?? "(no description)"}\nInput schema (JSON Schema):\n${JSON.stringify(entry.schema ?? {}, null, 2)}`,
				);
			}
			let args: Record<string, unknown>;
			try {
				const parsed: unknown = JSON.parse(params.args ?? "{}");
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
					throw new Error("args must encode a JSON object");
				}
				args = parsed as Record<string, unknown>;
			} catch (error) {
				return textResult(
					server,
					`Invalid args for '${entry.tool}': ${error instanceof Error ? error.message : String(error)}. Pass args as a JSON object STRING matching the schema from op:"describe", e.g. {"op":"call","tool":"${entry.tool}","args":"{\\"key\\": \\"value\\"}"}.`,
				);
			}
			return await executeMcpCatalogEntry(entry, args, signal, onUpdate);
		},
		renderCall(args, theme) {
			const detail = args.op === "search" ? (args.query ?? "") : (args.tool ?? "");
			return new Text(theme.fg("toolTitle", theme.bold(`${name} ${args.op} ${detail}`.trim())), 0, 0);
		},
		renderResult(result, options, theme) {
			const title = options.isPartial ? `${name}: running` : `${name}: ${result.details?.preview ?? "done"}`;
			return new Text(theme.fg("toolOutput", title), 0, 0);
		},
	};
}

function textResult(server: string, text: string): ProxyResult {
	return { content: [{ type: "text", text }], details: { preview: firstLine(text), server, tool: "proxy" } };
}

function unknownToolText(server: string, tool: string | undefined, index: ReturnType<typeof buildBm25Index>): string {
	const nearest = tool === undefined ? [] : index.search(tool, 3, {});
	const hint = nearest.length === 0 ? "" : ` Nearest matches: ${nearest.map((match) => match.doc.label).join(", ")}.`;
	return `Unknown tool '${tool ?? "(missing)"}' on '${server}'.${hint} Use op:"search" to list tools.`;
}

function firstLine(text: string): string {
	return text.split("\n", 1)[0].slice(0, 80);
}
