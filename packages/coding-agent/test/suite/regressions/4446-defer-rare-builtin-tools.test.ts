import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import goalExtension from "../../../src/core/extensions/builtin/goal/index.ts";
import htmlRenderExtension from "../../../src/core/extensions/builtin/html-render/index.ts";
import registerTerminalExtension from "../../../src/core/extensions/builtin/terminal/index.ts";
import toolSearchExtension from "../../../src/core/extensions/builtin/tool-search/index.ts";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";

// Regression for code-yeongyu/senpi#4446: builtin tools most sessions never call stay out of the
// first payload and the system prompt, and a by-name call still runs them in the same turn.
const DEFERRED = ["bash_input", "bash_resize", "get_goal", "show_html_page"];
const RESIDENT = ["bash", "bash_output", "kill_bash", "monitor", "create_goal", "update_goal"];

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function makeHarness(): Promise<Harness> {
	const extensionFactories: Array<{ factory: ExtensionFactory; path: string }> = [
		{ factory: registerTerminalExtension, path: "<builtin:terminal>" },
		{ factory: goalExtension, path: "<builtin:goal>" },
		{ factory: htmlRenderExtension, path: "<builtin:html-render>" },
		{ factory: toolSearchExtension, path: "<builtin:tool-search>" },
	];
	const harness = await createHarness({ extensionFactories });
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	return harness;
}

describe("regression senpi#4446: rarely used builtin tools are deferred", () => {
	it("keeps the deferred tools out of the first payload and the system prompt", async () => {
		const harness = await makeHarness();
		const firstPayloadTools: string[][] = [];
		harness.setResponses([
			(context) => {
				firstPayloadTools.push(getCurrentTools(context.messages).map((tool) => tool.name));
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("hello");

		const [tools] = firstPayloadTools;
		for (const name of DEFERRED) {
			expect(tools).not.toContain(name);
			const registered = harness.session.getAllTools().find((tool) => tool.name === name);
			expect(registered).toMatchObject({ exposure: "search", allowLazyActivation: true });
		}
		for (const name of RESIDENT) expect(tools).toContain(name);
		expect(tools).toContain("tool_search");
		const systemPrompt = harness.session.systemPrompt;
		expect(systemPrompt).not.toContain("- show_html_page:");
		expect(systemPrompt).not.toContain("- bash_resize:");
	});

	it("activates and runs a deferred tool on a by-name call without rewriting the system prompt", async () => {
		const harness = await makeHarness();
		const turns: { tools: string[]; systemPrompt: string }[] = [];
		harness.setResponses([
			(context) => {
				turns.push({
					tools: getCurrentTools(context.messages).map((tool) => tool.name),
					systemPrompt: harness.session.systemPrompt,
				});
				return fauxAssistantMessage(fauxToolCall("get_goal", {}), { stopReason: "toolUse" });
			},
			(context) => {
				turns.push({
					tools: getCurrentTools(context.messages).map((tool) => tool.name),
					systemPrompt: harness.session.systemPrompt,
				});
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("what is the goal?");

		expect(turns[0]?.tools).not.toContain("get_goal");
		expect(turns[1]?.tools).toContain("get_goal");
		expect(turns[1]?.systemPrompt).toBe(turns[0]?.systemPrompt);
		const results = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "toolResult")
			.map((entry) => JSON.stringify(entry));
		expect(results.some((text) => text.includes('"toolName":"get_goal"') && !text.includes('"isError":true'))).toBe(
			true,
		);
	});
});
