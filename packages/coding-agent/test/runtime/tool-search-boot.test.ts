import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import toolSearchExtension from "../../src/core/extensions/builtin/tool-search/index.ts";
import { getToolSearchServiceForExtension } from "../../src/core/extensions/builtin/tool-search/service.ts";
import { TOOL_SEARCH_TOOL_NAME } from "../../src/core/extensions/builtin/tool-search/tool.ts";
import type { ExtensionAPI, ToolDefinition } from "../../src/index.ts";
import { createHarness, type Harness } from "../suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";

function deferredTool(name: string): ToolDefinition {
	return {
		name,
		label: name,
		description: `${name} looks up stored records`,
		exposure: "search",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: `${name}-ran` }], details: {} }),
	};
}

const open: Harness[] = [];
afterEach(() => {
	for (const harness of open.splice(0)) harness.cleanup();
});

async function bootWithoutSessionStart(tools: readonly string[]) {
	let toolSearchPi: ExtensionAPI | undefined;
	const extensionsResult = await createTestExtensionsResult([
		{
			path: "<builtin:tool-search>",
			factory: (pi) => {
				toolSearchPi = pi;
				return toolSearchExtension(pi);
			},
		},
		{
			path: "/extensions/records.ts",
			factory: (pi) => {
				for (const name of tools) pi.registerTool(deferredTool(name));
			},
		},
	]);
	const harness = await createHarness({ resourceLoader: createTestResourceLoader({ extensionsResult }) });
	open.push(harness);
	if (toolSearchPi === undefined) throw new Error("tool-search did not load");
	const service = getToolSearchServiceForExtension(toolSearchPi);
	if (service === undefined) throw new Error("tool-search registered no service");
	return { harness, service };
}

describe("tool_search boots without a session start (RT5a)", () => {
	it("lists the searchable tools and turns tool_search on", async () => {
		// Given a runtime that loaded a searchable tool and never emitted session_start.
		const { harness } = await bootWithoutSessionStart(["records_lookup"]);
		// Then the resident tool_search is registered and active.
		expect(harness.session.getAllTools().map(({ name }) => name)).toContain(TOOL_SEARCH_TOOL_NAME);
		expect(harness.session.getActiveToolNames()).toContain(TOOL_SEARCH_TOOL_NAME);
	});

	it("finds and activates a searchable tool", async () => {
		const { harness, service } = await bootWithoutSessionStart(["records_lookup", "records_archive"]);
		// When a search names one tool.
		const matches = service.search("records_lookup", 1);
		// Then activating the match adds it to the active tools.
		expect(matches.map(({ name }) => name)).toEqual(["records_lookup"]);
		expect(service.activate(matches)).toEqual(["records_lookup"]);
		expect(harness.session.getActiveToolNames()).toContain("records_lookup");
		expect(harness.session.getActiveToolNames()).not.toContain("records_archive");
	});

	it("keeps tool_search off when nothing is searchable", async () => {
		const { harness } = await bootWithoutSessionStart([]);
		expect(harness.session.getActiveToolNames()).not.toContain(TOOL_SEARCH_TOOL_NAME);
	});
});
