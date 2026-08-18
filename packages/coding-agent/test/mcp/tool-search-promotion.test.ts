// MCP model-visible promotion semantics through the shared tool-search engine.

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolSearchDocument } from "../../src/core/extensions/builtin/tool-search/engine/document.ts";
import {
	rehydrate,
	TOOL_SEARCH_ACTIVATION_MARKER_V2,
} from "../../src/core/extensions/builtin/tool-search/engine/marker.ts";
import { ToolSearchService } from "../../src/core/extensions/builtin/tool-search/service.ts";
import {
	buildToolSearchResultText,
	createToolSearchTool,
	TOOL_SEARCH_TOOL_NAME,
} from "../../src/core/extensions/builtin/tool-search/tool.ts";
import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

const CATALOG: ToolSearchDocument[] = [
	{
		name: "mcp_docs_get-library-docs",
		label: "get-library-docs",
		aliases: ["get-library-docs"],
		description: "Fetch up-to-date documentation for a library",
		keywords: [],
		source: "mcp",
		group: "docs",
		ownerLabel: "docs",
		registrationId: "mcp\0docs\0get-library-docs",
	},
	{
		name: "mcp_docs_resolve-library-id",
		label: "resolve-library-id",
		aliases: ["resolve-library-id"],
		description: "Resolve a library name to a Context7-compatible ID",
		keywords: [],
		source: "mcp",
		group: "docs",
		ownerLabel: "docs",
		registrationId: "mcp\0docs\0resolve-library-id",
	},
	{
		name: "mcp_fs_read-file",
		label: "read-file",
		aliases: ["read-file"],
		description: "Read a file from disk",
		keywords: [],
		source: "mcp",
		group: "fs",
		ownerLabel: "fs",
		registrationId: "mcp\0fs\0read-file",
	},
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

function toolSearchExtension(): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		const service = new ToolSearchService({
			getAllTools: () => pi.getAllTools(),
			getActiveTools: () => pi.getActiveTools(),
			setActiveTools: (names) => pi.setActiveTools([...names]),
		});
		for (const entry of CATALOG) pi.registerTool(fakeMcpTool(entry.name));
		pi.registerTool(createToolSearchTool(service));
		let armed = false;
		pi.on("before_agent_start", async () => {
			if (armed) return undefined;
			armed = true;
			service.feed("mcp", CATALOG, {
				activate: (names) => pi.setActiveTools([...new Set([...pi.getActiveTools(), ...names])]),
			});
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
	const harness = await createHarness({
		extensionFactories: [{ factory: toolSearchExtension(), path: "<builtin:tool-search>" }],
	});
	harnesses.push(harness);
	return harness;
}

describe("shared tool_search: two-turn MCP promotion + zero-token inactive tools", () => {
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

		expect(providerToolNames[0]).toEqual(["tool_search"]);
		expect(providerToolNames[1]).toEqual(["mcp_docs_get-library-docs", "mcp_docs_resolve-library-id", "tool_search"]);
		expect(providerToolNames[1]).not.toContain("mcp_fs_read-file");
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
		expect(providerToolNames[1]).toEqual(["tool_search"]);
	});
});

describe("shared tool_search: result text + rehydration", () => {
	it("result text lists full names, a next-turn notice, and the v2 activation marker", () => {
		const matches = CATALOG.slice(0, 2).map((doc) => ({ name: doc.name, doc, score: 1, exact: false }));
		const text = buildToolSearchResultText("library docs", matches, "mcp", undefined);
		expect(text).toContain("NEXT turn");
		expect(text).toContain("mcp_docs_get-library-docs");
		expect(text).toContain("Fetch up-to-date documentation");
		expect(text).toContain(TOOL_SEARCH_ACTIVATION_MARKER_V2);
	});

	it("empty result carries no activation marker", () => {
		const text = buildToolSearchResultText("nope", [], "mcp", undefined);
		expect(text).not.toContain(TOOL_SEARCH_ACTIVATION_MARKER_V2);
		expect(text).toContain("unchanged");
	});

	it("rehydrate restores ownership-matching activations from a synthetic compacted session", () => {
		const matches = CATALOG.slice(0, 2).map((doc) => ({ name: doc.name, doc, score: 1, exact: false }));
		const messages = [{ content: buildToolSearchResultText("library docs", matches, "mcp", undefined) }];
		const current = new Map(CATALOG.map((doc) => [doc.name, { ...doc, allowLazyActivation: true }] as const));
		expect(rehydrate(messages, current)).toEqual(["mcp_docs_get-library-docs", "mcp_docs_resolve-library-id"]);
	});

	it("rehydrate drops names no longer in the catalog and is derivable from a real transcript", async () => {
		const harness = await makeHarness();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("tool_search", { query: "library documentation" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("find docs tool");
		const messages = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message);
		const current = new Map(CATALOG.map((doc) => [doc.name, { ...doc, allowLazyActivation: true }] as const));
		expect(rehydrate(messages, current)).toEqual(["mcp_docs_get-library-docs", "mcp_docs_resolve-library-id"]);
		current.delete("mcp_docs_resolve-library-id");
		expect(rehydrate(messages, current)).toEqual(["mcp_docs_get-library-docs"]);
	});

	it("legacy name-only markers remain compatible for MCP documents", () => {
		const current = new Map(CATALOG.map((doc) => [doc.name, { ...doc, allowLazyActivation: true }] as const));
		expect(rehydrate([{ content: "[tool_search:activated] mcp_docs_get-library-docs" }], current)).toEqual([
			"mcp_docs_get-library-docs",
		]);
	});
});
