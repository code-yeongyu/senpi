import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../../../src/index.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

const CityParameters = Type.Object({ city: Type.String() });

function deferredTool(name: string, allowLazyActivation = true): ToolDefinition<typeof CityParameters> {
	return {
		name,
		label: name,
		description: `${name} description`,
		exposure: "search",
		allowLazyActivation,
		parameters: CityParameters,
		execute: async (_id, params) => ({
			content: [{ type: "text" as const, text: `${name}-ran:${params.city}` }],
			details: {},
		}),
	};
}

async function callDeferred(
	tool: ToolDefinition<typeof CityParameters>,
	calledName: string,
): Promise<{ harness: Harness; result: ToolResultMessage }> {
	const harness = await createHarness({ extensionFactories: [(pi) => pi.registerTool(tool)] });
	harnesses.push(harness);
	harness.session.setActiveToolsByName(["read"]);
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall(calledName, { city: "Seoul" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);

	await harness.session.prompt("create the team");

	const result = harness.session.messages.find(
		(message): message is ToolResultMessage => message.role === "toolResult",
	);
	if (!result) throw new Error("expected a tool result");
	return { harness, result };
}

// #2025: a gateway-namespaced call to a deferred tool must activate and run it, not answer "not found".
describe("gateway-namespaced call to a deferred tool", () => {
	it("activates and runs the unique search-exposed tool behind mcp__<id>__<name>", async () => {
		const { harness, result } = await callDeferred(deferredTool("team_create"), "mcp__686f__team_create");

		expect(result.isError).toBe(false);
		expect(result.toolName).toBe("team_create");
		expect(getMessageText(result)).toContain("team_create-ran:Seoul");
		expect(getMessageText(result)).toContain('[auto-corrected] no tool is named "mcp__686f__team_create"');
		expect(harness.session.getActiveToolNames()).toContain("team_create");
	});

	it("resolves the PascalCase gateway form of the same deferred tool", async () => {
		const { result } = await callDeferred(deferredTool("team_create"), "mcp__686f__TeamCreate");

		expect(result.isError).toBe(false);
		expect(result.toolName).toBe("team_create");
	});

	it("keeps the allowLazyActivation hard stop for a namespaced call", async () => {
		const { harness, result } = await callDeferred(deferredTool("team_create", false), "mcp__686f__team_create");

		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toBe("Tool mcp__686f__team_create not found");
		expect(harness.session.getActiveToolNames()).not.toContain("team_create");
	});
});
