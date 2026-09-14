import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import imagegenExtension from "../../../src/core/extensions/builtin/imagegen/index.ts";
import { GENERATE_IMAGE_TOOL_NAME } from "../../../src/core/extensions/builtin/imagegen/tool.ts";
import toolSearchExtension from "../../../src/core/extensions/builtin/tool-search/index.ts";
import type { ExtensionAPI, ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function evalAndCatalogExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "eval",
		label: "Eval",
		description: "Evaluate code",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: "eval" }], details: {} }),
	});
	pi.registerTool({
		name: "weather_forecast",
		label: "weather_forecast",
		description: "Get hourly weather forecasts and rain predictions",
		exposure: "search",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: "weather_forecast-ran" }], details: {} }),
	});
}

async function makeHarness(): Promise<Harness> {
	const extensionFactories: Array<{ factory: ExtensionFactory; path: string }> = [
		{ factory: toolSearchExtension, path: "<builtin:tool-search>" },
		{ factory: imagegenExtension, path: "<builtin:imagegen>" },
		{ factory: evalAndCatalogExtension, path: "/workspace/extensions/eval-and-catalog.ts" },
	];
	const harness = await createHarness({ extensionFactories, evalOnlyToolNames: ["bash", "monitor"] });
	harnesses.push(harness);
	await harness.getExtensionRunner().emit({ type: "session_start", reason: "startup" });
	return harness;
}

function toolResultTexts(harness: Harness): string[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "message")
		.filter((entry) => entry.message.role === "toolResult")
		.map((entry) => JSON.stringify(entry.message));
}

describe("regression senpi#1682: tool_search is side-effect-free and answers hidden-tool queries", () => {
	it("a query naming eval-only bash gets the eval redirect hint instead of a bare no-match", async () => {
		const harness = await makeHarness();
		harness.session.setActiveToolsByName(["read", "bash", "eval", "tool_search"]);
		expect(harness.session.getActiveToolNames()).not.toContain("bash");
		const providerTools: string[][] = [];
		harness.setResponses([
			(context) => {
				providerTools.push((context.tools ?? []).map((tool) => tool.name));
				return fauxAssistantMessage(fauxToolCall("tool_search", { query: "bash execute shell command" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				providerTools.push((context.tools ?? []).map((tool) => tool.name));
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("find a shell tool");

		const searchResult = toolResultTexts(harness).find((text) => text.includes("tool_search"));
		expect(searchResult).toContain("No catalog tools matched");
		expect(searchResult).toContain("hidden in this session");
		expect(searchResult).toContain('tool.bash({ command: \\"...\\" })');
		expect(providerTools[1]).toEqual(providerTools[0]);
	});

	it("generate_image is search-exposed, absent from the first payload, and activates on a by-name call", async () => {
		const harness = await makeHarness();
		const registered = harness.session.getAllTools().find((tool) => tool.name === GENERATE_IMAGE_TOOL_NAME);
		expect(registered).toMatchObject({ exposure: "search", allowLazyActivation: true });
		expect(registered?.searchKeywords).toContain("image generation");
		expect(harness.session.getActiveToolNames()).not.toContain(GENERATE_IMAGE_TOOL_NAME);

		const providerTools: string[][] = [];
		harness.setResponses([
			(context) => {
				providerTools.push((context.tools ?? []).map((tool) => tool.name));
				return fauxAssistantMessage(fauxToolCall(GENERATE_IMAGE_TOOL_NAME, { prompt: "a cat on a mat" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				providerTools.push((context.tools ?? []).map((tool) => tool.name));
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("draw a cat");

		expect(providerTools[0]).not.toContain(GENERATE_IMAGE_TOOL_NAME);
		expect(providerTools[1]).toContain(GENERATE_IMAGE_TOOL_NAME);
		expect(harness.session.getActiveToolNames()).toContain(GENERATE_IMAGE_TOOL_NAME);
		const results = toolResultTexts(harness);
		expect(results.some((text) => text.includes(`"toolName":"${GENERATE_IMAGE_TOOL_NAME}"`))).toBe(true);
	});
});
