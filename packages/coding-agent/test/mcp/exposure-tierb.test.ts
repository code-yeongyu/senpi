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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import { createHarness, type Harness } from "../suite/harness.ts";
import { mcpRoot as makeMcpRoot, mcpExtensionFor, withoutMcpUtilityTools } from "./fixtures/register-call.ts";
import type { TestRoot } from "./fixtures/service-lifecycle.ts";
import { cleanupRoots, stdioServer } from "./fixtures/service-lifecycle.ts";

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
// Scope to MCP tools (mcp_search + mcp_<server>_<tool>); the harness's default
// base tools (bash/read/write) are separate senpi cost, not MCP resident cost.
function toolShapes(context: { tools?: { name: string; parameters?: unknown }[] }): ToolShape[] {
	return (context.tools ?? [])
		.filter((tool) => tool.name.startsWith("mcp_"))
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
	const harness = await createHarness({ extensionFactories: [mcpExtensionFor(root.agentDir)] });
	harnesses.push(harness);
	return harness;
}

describe("todo32 tier-B: searchThreshold flip", () => {
	it("10 filtered tools stay direct; 11 flip to search mode (only mcp_search resident)", async () => {
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
		expect(tenTools).not.toContain("mcp_search");

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
		expect(elevenTools).toEqual(["mcp_search"]);
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
		expect(directTools).not.toContain("mcp_search");

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
		expect(searchTools).toEqual(["mcp_search"]);
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
				residentJson = JSON.stringify(
					(context.tools ?? []).filter((tool) => withoutMcpUtilityTools([tool.name]).length > 0),
				);
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("go");
		expect(residentNames).toEqual(["mcp_search"]);
		// Method: chars/4 char-per-token approximation over the serialized tools array.
		const approxTokens = Math.ceil(residentJson.length / 4);
		expect(approxTokens).toBeLessThan(1000);
	});
});

describe("todo32 tier-B: stubSwap keeps the tools array byte-stable", () => {
	it("array length is constant across activations; byte-diff confined to the promoted entry; re-search is a no-op", async () => {
		const root = mcpRoot("stubswap");
		writeConfig(root, { fx: stdioServer(["--tools", "12"]) }, { stubSwap: true });
		const harness = await harnessFor(root);
		const turns: ToolShape[][] = [];
		harness.setResponses([
			(context) => {
				turns.push(toolShapes(context));
				// Exact-name promote just mcp_fx_tool_5.
				return fauxAssistantMessage(fauxToolCall("mcp_search", { query: "tool_5" }), { stopReason: "toolUse" });
			},
			(context) => {
				turns.push(toolShapes(context));
				// Flap: search the same tool again.
				return fauxAssistantMessage(fauxToolCall("mcp_search", { query: "tool_5" }), { stopReason: "toolUse" });
			},
			(context) => {
				turns.push(toolShapes(context));
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("promote tool_5");

		const [turn1, turn2, turn3] = turns as [ToolShape[], ToolShape[], ToolShape[]];
		// stubSwap keeps all 12 tools + mcp_search resident every turn (stable length).
		expect(turn1).toHaveLength(13);
		expect(turn2).toHaveLength(13);
		expect(turn3).toHaveLength(13);
		expect(names(turn1)).toEqual(names(turn2));

		// The promoted tool's bytes changed (stub -> full); it now carries real params.
		const t5before = turn1.find((shape) => shape.name === "mcp_fx_tool_5");
		const t5after = turn2.find((shape) => shape.name === "mcp_fx_tool_5");
		expect(t5before?.json).not.toEqual(t5after?.json);
		expect(t5after?.json).toContain("value");

		// Only promoted entries changed: every OTHER tool is byte-identical turn1->turn2.
		const changed = turn2.filter((after) => {
			const before = turn1.find((shape) => shape.name === after.name);
			return before?.json !== after.json;
		});
		expect(changed.some((shape) => shape.name === "mcp_fx_tool_5")).toBe(true);
		expect(changed.every((shape) => shape.name.startsWith("mcp_fx_tool_"))).toBe(true);

		// Flapping (re-search tool_5) is a byte-identical no-op: cache preserved.
		expect(turn3).toEqual(turn2);
	});
});
