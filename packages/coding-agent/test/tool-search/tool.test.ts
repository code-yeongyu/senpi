import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import toolSearchExtension from "../../src/core/extensions/builtin/tool-search/index.ts";
import type { ExtensionAPI, ExtensionFactory } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function searchableToolsExtension(pi: ExtensionAPI): void {
	for (const [name, description] of [
		["weather_forecast", "Get hourly weather forecasts and rain predictions"],
		["calendar_create", "Create calendar events and schedule meetings"],
	] as const) {
		pi.registerTool({
			name,
			label: name,
			description,
			exposure: "search",
			parameters: Type.Object({ city: Type.Optional(Type.String()) }),
			execute: async () => ({ content: [{ type: "text" as const, text: `${name}-ran` }], details: {} }),
		});
	}
}

async function makeHarness(): Promise<Harness> {
	const extensionFactories: Array<{ factory: ExtensionFactory; path: string }> = [
		{ factory: toolSearchExtension, path: "<builtin:tool-search>" },
		{ factory: searchableToolsExtension, path: "/workspace/extensions/searchable-tools.ts" },
	];
	const harness = await createHarness({ extensionFactories });
	harnesses.push(harness);
	await harness.getExtensionRunner().emit({ type: "session_start", reason: "startup" });
	return harness;
}

function relativeOrder(names: readonly string[], selected: ReadonlySet<string>): string[] {
	return names.filter((name) => selected.has(name));
}

function toolResultTexts(harness: Harness): string[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "message")
		.filter((entry) => entry.message.role === "toolResult")
		.map((entry) => JSON.stringify(entry.message));
}

describe("registered shared tool_search", () => {
	it("lists a match with its schema without activating it; the by-name call activates and runs it in the same turn", async () => {
		const harness = await makeHarness();
		const providerTools: string[][] = [];
		harness.setResponses([
			(context) => {
				providerTools.push((context.tools ?? []).map((tool) => tool.name));
				return fauxAssistantMessage(fauxToolCall("tool_search", { query: "hourly rain forecast" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				providerTools.push((context.tools ?? []).map((tool) => tool.name));
				return fauxAssistantMessage(fauxToolCall("weather_forecast", { city: "Seoul" }), { stopReason: "toolUse" });
			},
			(context) => {
				providerTools.push((context.tools ?? []).map((tool) => tool.name));
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("find and call a weather tool");

		expect(providerTools[0]).toContain("tool_search");
		expect(providerTools[0]).not.toContain("weather_forecast");
		expect(providerTools[1]).toEqual(providerTools[0]);
		expect(providerTools[2]).toContain("weather_forecast");
		expect(providerTools[2]).not.toContain("calendar_create");

		const results = toolResultTexts(harness);
		const searchResult = results.find((text) => text.includes("Found 1 tool(s)"));
		expect(searchResult).toBeDefined();
		expect(searchResult).toContain("weather_forecast");
		expect(searchResult).toContain("Nothing was activated");
		expect(searchResult).toContain('parameters: {\\"type\\":\\"object\\"');
		expect(searchResult).not.toContain("calendar_create");
		expect(results.some((text) => text.includes("weather_forecast-ran"))).toBe(true);
	});

	it("keeps pre-existing active entries in identical relative order across two by-name activations", async () => {
		const harness = await makeHarness();
		const snapshots: string[][] = [];
		harness.setResponses([
			(context) => {
				snapshots.push((context.tools ?? []).map((tool) => tool.name));
				return fauxAssistantMessage(fauxToolCall("weather_forecast", {}), { stopReason: "toolUse" });
			},
			(context) => {
				snapshots.push((context.tools ?? []).map((tool) => tool.name));
				return fauxAssistantMessage(fauxToolCall("calendar_create", {}), { stopReason: "toolUse" });
			},
			(context) => {
				snapshots.push((context.tools ?? []).map((tool) => tool.name));
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("activate two tools by name");

		const [before, afterFirst, afterSecond] = snapshots as [string[], string[], string[]];
		const original = new Set(before);
		const afterFirstSet = new Set(afterFirst);
		expect(relativeOrder(afterFirst, original)).toEqual(before);
		expect(relativeOrder(afterSecond, afterFirstSet)).toEqual(afterFirst);
		expect(afterFirst).toContain("weather_forecast");
		expect(afterSecond).toContain("calendar_create");
	});

	it("reports no match without touching the active set", async () => {
		const harness = await makeHarness();
		const providerTools: string[][] = [];
		harness.setResponses([
			(context) => {
				providerTools.push((context.tools ?? []).map((tool) => tool.name));
				return fauxAssistantMessage(fauxToolCall("tool_search", { query: "teleportation quantum xyzzy" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				providerTools.push((context.tools ?? []).map((tool) => tool.name));
				return fauxAssistantMessage("nothing");
			},
		]);

		await harness.session.prompt("search for a capability that does not exist");

		expect(providerTools[1]).toEqual(providerTools[0]);
		expect(toolResultTexts(harness).some((text) => text.includes("No catalog tools matched"))).toBe(true);
	});
});
