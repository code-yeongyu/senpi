// Todo 32 — Tier-B adaptive exposure + prompt-cache mitigations.
//
// Proves via the harness provider tap (context.tools = the exact tool set sent
// to the provider): the searchThreshold flip (10 direct -> 11 search), the
// per-server exposure override matrix, the <1k resident-token target for a
// 30-tool search-mode server, and stubSwap keeping the tools array
// length-stable across activations (byte-diff confined to promoted entries).

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpToolCatalogEntry } from "../../src/core/extensions/builtin/mcp/catalog.ts";
import { defaultSettings } from "../../src/core/extensions/builtin/mcp/config-schema.ts";
import { orderActiveSet, registerMcpTierBTools } from "../../src/core/extensions/builtin/mcp/expose/tier-b.ts";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import { TOOL_SEARCH_ACTIVATION_MARKER_V2 } from "../../src/core/extensions/builtin/tool-search/engine/marker.ts";
import { ToolSearchService } from "../../src/core/extensions/builtin/tool-search/service.ts";
import type { ToolDefinition } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../suite/harness.ts";
import {
	attachHarnessSession,
	mcpRoot as makeMcpRoot,
	mcpExtensionFor,
	withoutMcpUtilityTools,
} from "./fixtures/register-call.ts";
import type { TestRoot } from "./fixtures/service-lifecycle.ts";
import { cleanupRoots, fakePi, stdioServer } from "./fixtures/service-lifecycle.ts";

const cleanupTasks: Array<() => Promise<void>> = [];
const harnesses: Harness[] = [];

beforeEach(() => resetMcpServiceForTests());
afterEach(async () => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	await getMcpService().dispose("quit");
	resetMcpServiceForTests();
	await cleanupRoots(cleanupTasks);
});

function mcpRoot(slug: string): TestRoot {
	return makeMcpRoot(`exposure-tierb-${slug}`, cleanupTasks);
}

function writeConfig(root: TestRoot, servers: Record<string, unknown>, settings?: Record<string, unknown>): void {
	writeFileSync(
		join(root.agentDir, "mcp.json"),
		`${JSON.stringify(settings ? { settings, mcpServers: servers } : { mcpServers: servers }, null, 2)}\n`,
	);
}

interface ToolShape {
	name: string;
	json: string;
}
// Scope to MCP tools (tool_search + mcp_<server>_<tool>); the harness's default
// base tools (bash/read/write) are separate senpi cost, not MCP resident cost.
function toolShapes(context: { tools?: { name: string; parameters?: unknown }[] }): ToolShape[] {
	return (context.tools ?? [])
		.filter((tool) => tool.name.startsWith("mcp_") || tool.name === "tool_search")
		.map((tool) => ({ name: tool.name, json: JSON.stringify(tool) }))
		.sort(byName);
}
function byName(a: ToolShape, b: ToolShape): number {
	return a.name.localeCompare(b.name);
}
function names(shapes: ToolShape[]): string[] {
	return shapes.map((shape) => shape.name);
}

async function harnessFor(root: TestRoot): Promise<Harness> {
	const harness = await createHarness({
		extensionFactories: [{ factory: mcpExtensionFor(root.agentDir), path: "<builtin:mcp>" }],
	});
	harnesses.push(harness);
	// The harness never emits session_start on its own; attach + await the
	// raced registration so the first prompt's tool snapshot is deterministic.
	await attachHarnessSession(harness, "fx");
	return harness;
}

describe("todo32 tier-B: searchThreshold flip", () => {
	it("10 filtered tools stay direct; 11 flip to search mode (only tool_search resident)", async () => {
		const tenRoot = mcpRoot("flip-10");
		writeConfig(tenRoot, { fx: stdioServer(["--tools", "10"]) });
		const ten = await harnessFor(tenRoot);
		let tenTools: string[] = [];
		ten.setResponses([
			(context) => {
				tenTools = withoutMcpUtilityTools(names(toolShapes(context)));
				return fauxAssistantMessage("ok");
			},
		]);
		await ten.session.prompt("go");
		expect(tenTools).toHaveLength(10);
		expect(tenTools).not.toContain("tool_search");

		const elevenRoot = mcpRoot("flip-11");
		writeConfig(elevenRoot, { fx: stdioServer(["--tools", "11"]) });
		const eleven = await harnessFor(elevenRoot);
		let elevenTools: string[] = [];
		eleven.setResponses([
			(context) => {
				elevenTools = withoutMcpUtilityTools(names(toolShapes(context)));
				return fauxAssistantMessage("ok");
			},
		]);
		await eleven.session.prompt("go");
		expect(elevenTools).toEqual(["tool_search"]);
	});
});

describe("todo32 tier-B: exposure override matrix", () => {
	it("exposure:direct forces all tools active; exposure:search forces search mode below threshold", async () => {
		const directRoot = mcpRoot("override-direct");
		writeConfig(directRoot, { fx: { ...stdioServer(["--tools", "15"]), exposure: "direct" } });
		const direct = await harnessFor(directRoot);
		let directTools: string[] = [];
		direct.setResponses([
			(context) => {
				directTools = withoutMcpUtilityTools(names(toolShapes(context)));
				return fauxAssistantMessage("ok");
			},
		]);
		await direct.session.prompt("go");
		expect(directTools).toHaveLength(15);
		expect(directTools).not.toContain("tool_search");

		const searchRoot = mcpRoot("override-search");
		writeConfig(searchRoot, { fx: { ...stdioServer(["--tools", "5"]), exposure: "search" } });
		const search = await harnessFor(searchRoot);
		let searchTools: string[] = [];
		search.setResponses([
			(context) => {
				searchTools = withoutMcpUtilityTools(names(toolShapes(context)));
				return fauxAssistantMessage("ok");
			},
		]);
		await search.session.prompt("go");
		expect(searchTools).toEqual(["tool_search"]);
	});
});

describe("todo32 tier-B: resident token cost", () => {
	it("a 30-tool search-mode server resides in under 1k tokens (tokenizer approx)", async () => {
		const root = mcpRoot("resident-30");
		writeConfig(root, { fx: stdioServer(["--tools", "30"]) });
		const harness = await harnessFor(root);
		let residentJson = "";
		let residentNames: string[] = [];
		harness.setResponses([
			(context) => {
				const shapes = toolShapes(context);
				residentNames = withoutMcpUtilityTools(names(shapes));
				residentJson = JSON.stringify((context.tools ?? []).filter((tool) => residentNames.includes(tool.name)));
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("go");
		expect(residentNames).toEqual(["tool_search"]);
		// #1678: measure only the MCP resident set; core tools are separate senpi cost.
		// Method: chars/4 approximation over the serialized MCP tools array.
		const approxTokens = Math.ceil(residentJson.length / 4);
		expect(approxTokens).toBeLessThan(1000);
	});
});

describe("todo32 tier-B: stubSwap keeps the tools array byte-stable", () => {
	it("array length is constant; tool_search leaves every byte alone; the by-name call swaps stub->full and runs; a second call is a no-op", async () => {
		const root = mcpRoot("stubswap");
		writeConfig(root, { fx: stdioServer(["--tools", "12"]) }, { stubSwap: true });
		const harness = await harnessFor(root);
		const turns: ToolShape[][] = [];
		harness.setResponses([
			(context) => {
				turns.push(toolShapes(context));
				return fauxAssistantMessage(fauxToolCall("tool_search", { query: "tool_5" }), { stopReason: "toolUse" });
			},
			(context) => {
				turns.push(toolShapes(context));
				// By-name call against the resident stub: it promotes itself and runs in this turn.
				return fauxAssistantMessage(fauxToolCall("mcp_fx_tool_5", { value: "first" }), { stopReason: "toolUse" });
			},
			(context) => {
				turns.push(toolShapes(context));
				// Flap: call the now-full tool again.
				return fauxAssistantMessage(fauxToolCall("mcp_fx_tool_5", { value: "second" }), { stopReason: "toolUse" });
			},
			(context) => {
				turns.push(toolShapes(context));
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("promote tool_5");

		const [turn1, turn2, turn3, turn4] = turns as [ToolShape[], ToolShape[], ToolShape[], ToolShape[]];
		// stubSwap keeps all 12 tools + tool_search resident every turn (stable length).
		for (const turn of [turn1, turn2, turn3, turn4]) expect(turn).toHaveLength(13);
		expect(names(turn1)).toEqual(names(turn2));

		// tool_search is side-effect-free: turn2's payload is byte-identical to turn1's.
		expect(turn2).toEqual(turn1);

		// The by-name call swapped the stub for the full definition; it now carries real params.
		const t5before = turn2.find((shape) => shape.name === "mcp_fx_tool_5");
		const t5after = turn3.find((shape) => shape.name === "mcp_fx_tool_5");
		expect(t5before?.json).not.toEqual(t5after?.json);
		expect(t5after?.json).toContain("value");

		// Only the promoted entry changed turn2->turn3.
		const changed = turn3.filter((after) => {
			const before = turn2.find((shape) => shape.name === after.name);
			return before?.json !== after.json;
		});
		expect(changed.map((shape) => shape.name)).toEqual(["mcp_fx_tool_5"]);

		// A second by-name call is a byte-identical no-op: cache preserved.
		expect(turn4).toEqual(turn3);

		const results = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message")
			.filter((entry) => entry.message.role === "toolResult")
			.map((entry) => JSON.stringify(entry.message));
		expect(results.some((result) => result.includes(TOOL_SEARCH_ACTIVATION_MARKER_V2))).toBe(false);
		// Both by-name calls executed the real tool (the first one through the stub's promotion).
		expect(results.filter((result) => result.includes('"toolName":"mcp_fx_tool_5"'))).toHaveLength(2);

		// Catalog membership, not an mcp_ prefix, controls the sorted suffix.
		const catalogNames = new Set(["weather_forecast", "calendar_create"]);
		const firstPromotion = orderActiveSet(
			["base_second", "weather_forecast", "base_first"],
			["base_first", "base_second"],
			catalogNames,
		);
		const secondPromotion = orderActiveSet([...firstPromotion, "calendar_create"], firstPromotion, catalogNames);
		expect(secondPromotion).toEqual(["base_first", "base_second", "calendar_create", "weather_forecast"]);
	});
});

describe("stubSwap re-registration keeps promoted tools full", () => {
	it("a background catalog refresh after a by-name promotion does not hand the tool back as a stub", () => {
		const definitions = new Map<string, { parameters: unknown }>();
		let active: string[] = [];
		const pi = {
			getActiveTools: () => [...active],
			setActiveTools: (names: string[]) => {
				active = [...names];
			},
			registerTool<TParams extends TSchema, TDetails, TState>(
				definition: ToolDefinition<TParams, TDetails, TState>,
			) {
				definitions.set(definition.name, { parameters: definition.parameters });
				if (!active.includes(definition.name)) active.push(definition.name);
			},
		};
		const toolSearchService = new ToolSearchService({
			getAllTools: () => [],
			getActiveTools: () => pi.getActiveTools(),
			setActiveTools: (names) => pi.setActiveTools([...names]),
		});
		const entries: McpToolCatalogEntry[] = ["alpha", "beta"].map((tool) => ({
			server: "fx",
			tool,
			schema: { type: "object", properties: { value: { type: "string" } } },
			requestTimeoutMs: 1_000,
			connection: {} as McpToolCatalogEntry["connection"],
		}));
		const input = {
			registeredEntries: entries,
			activeEntries: [],
			searchMode: true,
			settings: { ...defaultSettings, stubSwap: true },
		};
		const isStub = (name: string) =>
			JSON.stringify(definitions.get(name)?.parameters).includes('"additionalProperties":true');

		const first = registerMcpTierBTools(pi, input, toolSearchService);
		expect(isStub("mcp_fx_alpha")).toBe(true);

		// The model's by-name call promotes alpha (stub -> full).
		first.activate(["mcp_fx_alpha"]);
		expect(isStub("mcp_fx_alpha")).toBe(false);
		expect(isStub("mcp_fx_beta")).toBe(true);

		// A cold lazy server's background connect re-registers the whole catalog.
		registerMcpTierBTools(pi, input, toolSearchService);
		expect(isStub("mcp_fx_alpha")).toBe(false);
		expect(isStub("mcp_fx_beta")).toBe(true);
		expect(active).toContain("mcp_fx_alpha");
	});
});

describe("todo8 tier-B: shared tool-search feed contract", () => {
	it("feeds each MCP tool name as both its label and alias", () => {
		const pi = fakePi();
		const toolSearchService = new ToolSearchService({
			getAllTools: () => [],
			getActiveTools: () => pi.getActiveTools(),
			setActiveTools: (names) => pi.setActiveTools([...names]),
		});
		const feed = vi.spyOn(toolSearchService, "feed");
		const entries: McpToolCatalogEntry[] = ["calendar_create", "weather_forecast"].map((tool) => ({
			server: "extension-catalog",
			tool,
			schema: { type: "object" },
			requestTimeoutMs: 1_000,
			connection: {} as McpToolCatalogEntry["connection"],
		}));

		registerMcpTierBTools(
			pi,
			{ registeredEntries: entries, activeEntries: [], searchMode: true, settings: defaultSettings },
			toolSearchService,
		);

		const documents = feed.mock.calls[0]?.[1] ?? [];
		expect(documents.map(({ name, label, aliases }) => ({ name, label, aliases }))).toEqual([
			{
				name: "mcp_extension-catalog_calendar_create",
				label: "calendar_create",
				aliases: ["calendar_create"],
			},
			{
				name: "mcp_extension-catalog_weather_forecast",
				label: "weather_forecast",
				aliases: ["weather_forecast"],
			},
		]);
	});
});
