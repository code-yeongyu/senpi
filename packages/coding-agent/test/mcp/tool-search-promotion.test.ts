// Todo 31 — tool_search tool + promotion engine.
//
// Proves: turn-1 search lists full names + "next turn" and activates matches;
// turn-2 the promoted tool is callable; inactive tools contribute ZERO tokens
// to the provider payload (they never appear in context.tools); a nonexistent
// capability activates nothing and leaves the next turn unchanged; and
// activations are derivable from a real session transcript (rehydrate).

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildMcpSearchResultText,
	createMcpSearchTool,
	rehydrateActiveToolsFromHistory,
	type SearchableMcpTool,
	TOOL_SEARCH_ACTIVATION_MARKER,
	TOOL_SEARCH_TOOL_NAME,
	unionStable,
} from "../../src/core/extensions/builtin/mcp/expose/tool-search.ts";
import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

const CATALOG: SearchableMcpTool[] = [
	{
		name: "mcp_docs_get-library-docs",
		toolName: "get-library-docs",
		description: "Fetch up-to-date documentation for a library",
		server: "docs",
	},
	{
		name: "mcp_docs_resolve-library-id",
		toolName: "resolve-library-id",
		description: "Resolve a library name to a Context7-compatible ID",
		server: "docs",
	},
	{ name: "mcp_fs_read-file", toolName: "read-file", description: "Read a file from disk", server: "fs" },
];

function fakeMcpTool(name: string): ToolDefinition {
	return {
		name,
		label: name,
		description: `fake ${name}`,
		parameters: Type.Object({}),
		executionMode: "parallel",
		execute: async () => ({ content: [{ type: "text", text: `called ${name}` }], details: {} }),
	};
}

// Extension that registers the catalog tools (inactive) + an always-active
// tool_search wired to promote via pi.setActiveTools.
function toolSearchExtension(): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		for (const entry of CATALOG) pi.registerTool(fakeMcpTool(entry.name));
		pi.registerTool(
			createMcpSearchTool({
				getSearchableTools: () => CATALOG,
				getActiveTools: () => pi.getActiveTools(),
				setActiveTools: (names) => pi.setActiveTools([...names]),
			}),
		);
		let armed = false;
		pi.on("before_agent_start", async () => {
			if (armed) return undefined;
			armed = true;
			// Only tool_search is active initially; catalog tools stay inactive.
			pi.setActiveTools([TOOL_SEARCH_TOOL_NAME]);
			return undefined;
		});
	};
}

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function makeHarness(): Promise<Harness> {
	const harness = await createHarness({ extensionFactories: [toolSearchExtension()] });
	harnesses.push(harness);
	return harness;
}

describe("todo31 tool_search: two-turn promotion + zero-token inactive tools", () => {
	it("turn1 search activates matches; turn2 they are callable; unmatched stay inactive", async () => {
		const harness = await makeHarness();
		const providerToolNames: string[][] = [];
		harness.setResponses([
			(context) => {
				providerToolNames.push((context.tools ?? []).map((tool) => tool.name).sort());
				return fauxAssistantMessage(fauxToolCall("tool_search", { query: "library documentation" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				providerToolNames.push((context.tools ?? []).map((tool) => tool.name).sort());
				return fauxAssistantMessage(fauxToolCall("mcp_docs_get-library-docs", {}), { stopReason: "toolUse" });
			},
			(context) => {
				providerToolNames.push((context.tools ?? []).map((tool) => tool.name).sort());
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("find a docs tool");

		// Turn 1: only tool_search was exposed — inactive catalog tools cost 0 tokens.
		expect(providerToolNames[0]).toEqual(["tool_search"]);
		// Turn 2: the two matched docs tools are now active alongside tool_search;
		// the unmatched mcp_fs_read-file is still absent (zero contribution).
		expect(providerToolNames[1]).toEqual(["mcp_docs_get-library-docs", "mcp_docs_resolve-library-id", "tool_search"]);
		expect(providerToolNames[1]).not.toContain("mcp_fs_read-file");
		// The promoted tool actually ran.
		expect(harness.session.getActiveToolNames()).toContain("mcp_docs_get-library-docs");
	});

	it("nonexistent capability activates nothing; next turn payload unchanged", async () => {
		const harness = await makeHarness();
		const providerToolNames: string[][] = [];
		harness.setResponses([
			(context) => {
				providerToolNames.push((context.tools ?? []).map((tool) => tool.name).sort());
				return fauxAssistantMessage(fauxToolCall("tool_search", { query: "teleportation quantum xyzzy" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				providerToolNames.push((context.tools ?? []).map((tool) => tool.name).sort());
				return fauxAssistantMessage("nothing found");
			},
		]);

		await harness.session.prompt("search for a capability that does not exist");

		expect(providerToolNames[0]).toEqual(["tool_search"]);
		// No activation -> next turn identical.
		expect(providerToolNames[1]).toEqual(["tool_search"]);
	});
});

describe("todo31 tool_search: result text + rehydration", () => {
	it("result text lists full names, a next-turn notice, and the activation marker", () => {
		const matches = [
			{ name: "mcp_docs_get-library-docs", doc: CATALOG[0] as SearchableMcpTool },
			{ name: "mcp_docs_resolve-library-id", doc: CATALOG[1] as SearchableMcpTool },
		];
		const text = buildMcpSearchResultText("library docs", matches, undefined);
		expect(text).toContain("NEXT turn");
		expect(text).toContain("mcp_docs_get-library-docs");
		expect(text).toContain("Fetch up-to-date documentation");
		expect(text).toContain(`${TOOL_SEARCH_ACTIVATION_MARKER} mcp_docs_get-library-docs mcp_docs_resolve-library-id`);
	});

	it("empty result carries no activation marker", () => {
		const text = buildMcpSearchResultText("nope", [], undefined);
		expect(text).not.toContain(TOOL_SEARCH_ACTIVATION_MARKER);
		expect(text).toContain("unchanged");
	});

	it("rehydrateActiveToolsFromHistory restores activations from a synthetic compacted session", () => {
		const valid = new Set(CATALOG.map((entry) => entry.name));
		const messages = [
			{ role: "user", content: "find docs tools" },
			{
				role: "toolResult",
				toolName: TOOL_SEARCH_TOOL_NAME,
				content: [
					{
						type: "text",
						text: buildMcpSearchResultText(
							"library docs",
							[
								{ name: "mcp_docs_get-library-docs", doc: CATALOG[0] as SearchableMcpTool },
								{ name: "mcp_docs_resolve-library-id", doc: CATALOG[1] as SearchableMcpTool },
							],
							undefined,
						),
					},
				],
			},
		];
		expect(rehydrateActiveToolsFromHistory(messages, valid)).toEqual([
			"mcp_docs_get-library-docs",
			"mcp_docs_resolve-library-id",
		]);
	});

	it("rehydrate drops names no longer in the catalog and is derivable from a real transcript", async () => {
		// Real session: run a search, then reconstruct activations from history.
		const harness = await makeHarness();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("tool_search", { query: "library documentation" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("find docs tool");

		const entries = harness.sessionManager.getEntries();
		const messages = entries.filter((entry) => entry.type === "message").map((entry) => entry.message);
		// Full catalog still valid -> both matches restored.
		expect(rehydrateActiveToolsFromHistory(messages, new Set(CATALOG.map((entry) => entry.name)))).toEqual([
			"mcp_docs_get-library-docs",
			"mcp_docs_resolve-library-id",
		]);
		// One tool removed from the catalog -> it is not restored.
		expect(rehydrateActiveToolsFromHistory(messages, new Set(["mcp_docs_get-library-docs"]))).toEqual([
			"mcp_docs_get-library-docs",
		]);
	});

	it("unionStable dedupes and sorts", () => {
		expect(unionStable(["tool_search", "b"], ["a", "b"])).toEqual(["a", "b", "tool_search"]);
	});
});
