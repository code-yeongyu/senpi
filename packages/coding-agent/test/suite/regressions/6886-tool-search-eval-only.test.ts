import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import toolSearchExtension from "../../../src/core/extensions/builtin/tool-search/index.ts";
import type { ExtensionAPI, ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * senpi#6886: tool_search is where a model looks for a tool a prompt names but its direct list lacks. Eval-only
 * tools (declared `exposure: "eval"`, or eval-only by name such as `workflow`) are withheld from that list while an
 * eval tool is registered, so a search that cannot see them makes the model conclude a registered tool is missing.
 */

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function tool(name: string, description: string, exposure?: "search" | "eval") {
	return {
		name,
		label: name,
		description,
		...(exposure === undefined ? {} : { exposure }),
		parameters: Type.Object({ limit: Type.Optional(Type.Number()) }),
		execute: async () => ({ content: [{ type: "text" as const, text: `${name}-ran` }], details: {} }),
	};
}

function toolsExtension(options: { withEval: boolean }): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		if (options.withEval) pi.registerTool(tool("eval", "Evaluate code"));
		pi.registerTool(tool("weather_forecast", "Get hourly weather forecasts and rain predictions", "search"));
		pi.registerTool(tool("thread_list", "List peer agent sessions (threads) you can message", "eval"));
		pi.registerTool(tool("workflow", "Run a dependency-ordered graph of agent workflow steps"));
	};
}

async function makeHarness(options: { withEval: boolean }): Promise<Harness> {
	const harness = await createHarness({
		extensionFactories: [
			{ factory: toolSearchExtension, path: "<builtin:tool-search>" },
			{ factory: toolsExtension(options), path: "/workspace/extensions/tools.ts" },
		],
	});
	harnesses.push(harness);
	await harness.getExtensionRunner().emit({ type: "session_start", reason: "startup" });
	return harness;
}

async function searchOnce(harness: Harness, query: string): Promise<{ text: string; nextTools: string[] }> {
	const nextTools: string[] = [];
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("tool_search", { query }), { stopReason: "toolUse" }),
		(context) => {
			nextTools.push(...getCurrentTools(context.messages).map((entry) => entry.name));
			return fauxAssistantMessage("done");
		},
	]);
	await harness.session.prompt(`search for ${query}`);
	const result = harness.sessionManager
		.getEntries()
		.flatMap((entry) => (entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []))
		.at(-1);
	const text = (result?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
	return { text, nextTools };
}

describe("senpi#6886 tool_search finds eval-only tools", () => {
	it("returns a declared eval-only tool marked eval-only with its eval call form and does not activate it", async () => {
		const harness = await makeHarness({ withEval: true });

		const { text, nextTools } = await searchOnce(harness, "list peer agent threads");

		expect(text).toContain("thread_list");
		expect(text).toMatch(/eval-only/i);
		expect(text).toContain("tool.thread_list(");
		expect(nextTools).not.toContain("thread_list");
		expect(harness.session.getActiveToolNames()).not.toContain("thread_list");
	});

	it("finds a tool that is eval-only by name, not by declared exposure", async () => {
		const harness = await makeHarness({ withEval: true });

		const { text } = await searchOnce(harness, "run a dependency-ordered graph of agent steps");

		expect(text).toContain("tool.workflow(");
		expect(harness.session.getActiveToolNames()).not.toContain("workflow");
	});

	it("reports the session's eval-only routing on getAllTools, and nothing when no eval tool arms it", async () => {
		const armed = await makeHarness({ withEval: true });
		const evalOnly = armed.session
			.getAllTools()
			.filter((info) => info.evalOnly === true)
			.map((info) => info.name);
		expect(evalOnly).toEqual(expect.arrayContaining(["thread_list", "workflow"]));
		expect(evalOnly).not.toContain("eval");
		expect(evalOnly).not.toContain("weather_forecast");

		const unarmed = await makeHarness({ withEval: false });
		expect(unarmed.session.getAllTools().filter((info) => info.evalOnly === true)).toEqual([]);
		const { text } = await searchOnce(unarmed, "list peer agent threads");
		expect(text).not.toContain("tool.thread_list(");
	});
});
