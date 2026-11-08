import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import toolSearchExtension from "../../../src/core/extensions/builtin/tool-search/index.ts";
import type { ExtensionAPI, ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function weatherExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "weather_lookup",
		label: "weather_lookup",
		description: "Look up the weather for a city",
		exposure: "search",
		parameters: Type.Object({ city: Type.String() }),
		execute: async () => ({ content: [{ type: "text" as const, text: "weather_lookup-ran" }], details: {} }),
	});
}

// issue #6219, see the issue for the full transport-level failure analysis.
async function makeHarness(): Promise<Harness> {
	const extensionFactories: Array<{ factory: ExtensionFactory; path: string }> = [
		{ factory: toolSearchExtension, path: "<builtin:tool-search>" },
		{ factory: weatherExtension, path: "/workspace/extensions/weather.ts" },
	];
	const harness = await createHarness({ extensionFactories, api: "openai-completions" });
	harnesses.push(harness);
	await harness.getExtensionRunner().emit({ type: "session_start", reason: "startup" });
	return harness;
}

describe("regression issue-6219: tool_search stages matches for strict openai-completions transports", () => {
	it("a match search makes the tool callable in the next request and the by-name call activates it", async () => {
		const harness = await makeHarness();
		const providerTools: string[][] = [];
		harness.setResponses([
			(context) => {
				providerTools.push(getCurrentTools(context.messages).map((tool) => tool.name));
				return fauxAssistantMessage(fauxToolCall("tool_search", { query: "look up weather for a city" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				providerTools.push(getCurrentTools(context.messages).map((tool) => tool.name));
				return fauxAssistantMessage(fauxToolCall("weather_lookup", { city: "Paris" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				providerTools.push(getCurrentTools(context.messages).map((tool) => tool.name));
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("what is the weather in Paris?");

		expect(providerTools[0]).not.toContain("weather_lookup");
		expect(providerTools[1]).toContain("weather_lookup");
		expect(harness.session.getActiveToolNames()).toContain("weather_lookup");
		expect(providerTools[2]).toContain("weather_lookup");
		const results = JSON.stringify(harness.sessionManager.getEntries());
		expect(results).toContain("weather_lookup-ran");
	});

	it("staging evaporates when the model never calls the matched tool", async () => {
		const harness = await makeHarness();
		const providerTools: string[][] = [];
		harness.setResponses([
			(context) => {
				providerTools.push(getCurrentTools(context.messages).map((tool) => tool.name));
				return fauxAssistantMessage(fauxToolCall("tool_search", { query: "look up weather for a city" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				providerTools.push(getCurrentTools(context.messages).map((tool) => tool.name));
				return fauxAssistantMessage("not needed, thanks");
			},
			(context) => {
				providerTools.push(getCurrentTools(context.messages).map((tool) => tool.name));
				return fauxAssistantMessage("hello");
			},
		]);

		await harness.session.prompt("what is the weather in Paris?");
		await harness.session.prompt("hi");

		expect(providerTools[0]).not.toContain("weather_lookup");
		expect(providerTools[1]).toContain("weather_lookup");
		expect(providerTools[2]).not.toContain("weather_lookup");
		expect(harness.session.getActiveToolNames()).not.toContain("weather_lookup");
	});

	it("a no-match search leaves consecutive payloads equal", async () => {
		const harness = await makeHarness();
		const providerTools: string[][] = [];
		harness.setResponses([
			(context) => {
				providerTools.push(getCurrentTools(context.messages).map((tool) => tool.name));
				return fauxAssistantMessage(fauxToolCall("tool_search", { query: "zzz-no-such-capability" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				providerTools.push(getCurrentTools(context.messages).map((tool) => tool.name));
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("find a zzz tool");

		expect(providerTools[1]).toEqual(providerTools[0]);
	});
});
