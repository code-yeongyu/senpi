// MCP model-visible activation semantics through the shared tool-search engine:
// tool_search only lists catalog tools; the model's by-name call activates one.

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolSearchDocument } from "../../src/core/extensions/builtin/tool-search/engine/document.ts";
import {
	emitActivationMarker,
	rehydrate,
	TOOL_SEARCH_ACTIVATION_MARKER_V2,
} from "../../src/core/extensions/builtin/tool-search/engine/marker.ts";
import toolSearchExtension, { getToolSearchService } from "../../src/core/extensions/builtin/tool-search/index.ts";
import { buildToolSearchResultText } from "../../src/core/extensions/builtin/tool-search/tool.ts";
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
		parameters: Type.Object({ topic: Type.Optional(Type.String()) }),
		executionMode: "parallel",
		execute: async () => ({ content: [{ type: "text", text: `called ${name}` }], details: {} }),
	};
}

function mcpFeedExtension(): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		for (const entry of CATALOG) pi.registerTool(fakeMcpTool(entry.name));
		let armed = false;
		pi.on("before_agent_start", async () => {
			if (armed) return undefined;
			armed = true;
			getToolSearchService().feed("mcp", CATALOG, {
				activate: (names) => pi.setActiveTools([...new Set([...pi.getActiveTools(), ...names])]),
			});
			pi.setActiveTools(pi.getActiveTools().filter((name) => !CATALOG.some((doc) => doc.name === name)));
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
		extensionFactories: [
			{ factory: toolSearchExtension, path: "<builtin:tool-search>" },
			{ factory: mcpFeedExtension(), path: "/workspace/extensions/mcp-feed.ts" },
		],
	});
	harnesses.push(harness);
	await harness.getExtensionRunner().emit({ type: "session_start", reason: "startup" });
	return harness;
}

function mcpNames(context: { tools?: readonly { name: string }[] }): string[] {
	return (context.tools ?? [])
		.map((tool) => tool.name)
		.filter((name) => name === "tool_search" || name.startsWith("mcp_"))
		.sort();
}

describe("shared tool_search: MCP catalog listing + by-name activation of zero-token inactive tools", () => {
	it("search lists matches without activating; the by-name call activates and runs; unmatched stay inactive", async () => {
		const harness = await makeHarness();
		const providerToolNames: string[][] = [];
		harness.setResponses([
			(context) => {
				providerToolNames.push(mcpNames(context));
				return fauxAssistantMessage(fauxToolCall("tool_search", { query: "library documentation" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				providerToolNames.push(mcpNames(context));
				return fauxAssistantMessage(fauxToolCall("mcp_docs_get-library-docs", { topic: "hono" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				providerToolNames.push(mcpNames(context));
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("find a docs tool");

		expect(providerToolNames[0]).toEqual(["tool_search"]);
		expect(providerToolNames[1]).toEqual(["tool_search"]);
		expect(providerToolNames[2]).toEqual(["mcp_docs_get-library-docs", "tool_search"]);
		expect(harness.session.getActiveToolNames()).toContain("mcp_docs_get-library-docs");
		expect(harness.session.getActiveToolNames()).not.toContain("mcp_fs_read-file");
		const results = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message")
			.filter((entry) => entry.message.role === "toolResult")
			.map((entry) => JSON.stringify(entry.message));
		expect(results.some((text) => text.includes("called mcp_docs_get-library-docs"))).toBe(true);
		const searchText = results.find((text) => text.includes("Found "));
		expect(searchText).toContain("mcp_docs_get-library-docs");
		expect(searchText).not.toContain("mcp_fs_read-file");
	});

	it("nonexistent capability activates nothing; next turn payload unchanged", async () => {
		const harness = await makeHarness();
		const providerToolNames: string[][] = [];
		harness.setResponses([
			(context) => {
				providerToolNames.push(mcpNames(context));
				return fauxAssistantMessage(fauxToolCall("tool_search", { query: "teleportation quantum xyzzy" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				providerToolNames.push(mcpNames(context));
				return fauxAssistantMessage("nothing found");
			},
		]);

		await harness.session.prompt("search for a capability that does not exist");
		expect(providerToolNames[0]).toEqual(["tool_search"]);
		expect(providerToolNames[1]).toEqual(["tool_search"]);
	});
});

describe("shared tool_search: result text + legacy rehydration", () => {
	const noHints = { hiddenHints: [], parametersOf: () => undefined } as const;

	it("result text lists full names, the by-name notice, and no activation marker", () => {
		const matches = CATALOG.slice(0, 2).map((doc) => ({ name: doc.name, doc, score: 1, exact: false, coverage: 1 }));
		const text = buildToolSearchResultText({
			...noHints,
			group: undefined,
			matches,
			query: "library docs",
			source: "mcp",
		});
		expect(text).toContain("call one by name");
		expect(text).toContain("mcp_docs_get-library-docs");
		expect(text).toContain("Fetch up-to-date documentation");
		expect(text).not.toContain("NEXT turn");
		expect(text).not.toContain(TOOL_SEARCH_ACTIVATION_MARKER_V2);
	});

	it("empty result carries no activation marker", () => {
		const text = buildToolSearchResultText({
			...noHints,
			group: undefined,
			matches: [],
			query: "nope",
			source: "mcp",
		});
		expect(text).not.toContain(TOOL_SEARCH_ACTIVATION_MARKER_V2);
		expect(text).toContain("unchanged");
	});

	it("rehydrate restores ownership-matching v2 markers from older transcripts", () => {
		const marker = emitActivationMarker(
			CATALOG.slice(0, 2).map((doc) => ({ name: doc.name, registrationId: doc.registrationId })),
		);
		const current = new Map(CATALOG.map((doc) => [doc.name, { ...doc, allowLazyActivation: true }] as const));
		expect(rehydrate([{ content: marker }], current)).toEqual([
			"mcp_docs_get-library-docs",
			"mcp_docs_resolve-library-id",
		]);
		current.delete("mcp_docs_resolve-library-id");
		expect(rehydrate([{ content: marker }], current)).toEqual(["mcp_docs_get-library-docs"]);
	});

	it("a new-style transcript carries no marker, so rehydration restores nothing from it", async () => {
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
		expect(rehydrate(messages, current)).toEqual([]);
	});

	it("legacy name-only markers remain compatible for MCP documents", () => {
		const current = new Map(CATALOG.map((doc) => [doc.name, { ...doc, allowLazyActivation: true }] as const));
		expect(rehydrate([{ content: "[tool_search:activated] mcp_docs_get-library-docs" }], current)).toEqual([
			"mcp_docs_get-library-docs",
		]);
	});
});
