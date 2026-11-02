import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../../src/index.ts";
import { createHarness } from "../harness.ts";

interface ProviderRequest {
	tools: string[];
	activeToolNames: string[] | undefined;
	systemPrompt: string;
}

const TOOL_ORDER = ["keep_read", "ask_like", "keep_write"];

// Faux factories receive a TranscriptContext (A2 C-AI-2): prompt and declared tools live in system messages.
function recordRequest(requests: ProviderRequest[], context: TranscriptContext): void {
	requests.push({
		tools: getCurrentTools(context.messages).map((tool) => tool.name),
		activeToolNames: context.activeToolNames,
		systemPrompt: getCurrentSystemPrompt(context.messages),
	});
}

function askLikeExtension(counter: { askLikeRuns: number }): ExtensionFactory {
	return (pi) => {
		for (const name of ["keep_read", "keep_write"]) {
			pi.registerTool({
				name,
				label: name,
				description: `${name} tool`,
				promptSnippet: `Snippet for ${name}`,
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
			});
		}
		pi.registerTool({
			name: "ask_like",
			label: "ask_like",
			description: "Removes itself from the active tools when it runs",
			promptSnippet: "Snippet for ask_like",
			parameters: Type.Object({}),
			execute: async () => {
				counter.askLikeRuns++;
				pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "ask_like"));
				return { content: [{ type: "text", text: "asked" }], details: {} };
			},
		});
	};
}

async function runRemovalAndRestore(options: { supportsAllowedTools: boolean; baseUrl?: string }) {
	const counter = { askLikeRuns: 0 };
	const harness = await createHarness({ extensionFactories: [askLikeExtension(counter)] });
	try {
		if (options.supportsAllowedTools) {
			Object.assign(harness.agent.state.model, {
				baseUrl: options.baseUrl ?? "https://api.openai.com/v1",
				compat: { supportsAllowedTools: true },
			});
		}
		harness.session.setActiveToolsByName(TOOL_ORDER);
		const requests: ProviderRequest[] = [];
		harness.setResponses([
			(context) => {
				recordRequest(requests, context);
				return fauxAssistantMessage(fauxToolCall("ask_like", {}), { stopReason: "toolUse" });
			},
			(context) => {
				recordRequest(requests, context);
				return fauxAssistantMessage(fauxToolCall("ask_like", {}), { stopReason: "toolUse" });
			},
			(context) => {
				recordRequest(requests, context);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("start");

		harness.session.setActiveToolsByName([...harness.session.getActiveToolNames(), "ask_like"]);
		harness.setResponses([
			(context) => {
				recordRequest(requests, context);
				return fauxAssistantMessage("restored");
			},
		]);
		await harness.session.prompt("again");

		const toolResults = harness.session.messages.flatMap((message) =>
			message.role === "toolResult"
				? [
						{
							isError: message.isError,
							text: message.content.map((part) => ("text" in part ? part.text : "")).join(""),
						},
					]
				: [],
		);
		return { requests, toolResults, askLikeRuns: counter.askLikeRuns };
	} finally {
		harness.cleanup();
	}
}

// senpi#2095: tool definitions and the prompt tool section stay byte-stable when the active set shrinks and re-grows.
describe("allowed-tools stable tool declarations", () => {
	it("keeps tools and the system prompt identical across a removal and a restore on a flagged model", async () => {
		const { requests, toolResults, askLikeRuns } = await runRemovalAndRestore({ supportsAllowedTools: true });

		expect(requests).toHaveLength(4);
		const declared = requests[0]?.tools ?? [];
		expect(declared).toEqual(expect.arrayContaining(TOOL_ORDER));
		for (const request of requests) {
			expect(request.tools).toEqual(declared);
			expect(request.systemPrompt).toBe(requests[0]?.systemPrompt);
		}
		expect(requests[0]?.systemPrompt).toContain("ask_like: Snippet for ask_like");
		expect(requests[0]?.activeToolNames).toEqual(declared.length === TOOL_ORDER.length ? undefined : TOOL_ORDER);
		expect(requests[1]?.activeToolNames).toEqual(["keep_read", "keep_write"]);
		expect(requests[2]?.activeToolNames).toEqual(["keep_read", "keep_write"]);
		expect(new Set(requests[3]?.activeToolNames ?? requests[3]?.tools)).toEqual(new Set(TOOL_ORDER));

		expect(askLikeRuns).toBe(1);
		expect(toolResults[0]).toEqual({ isError: false, text: "asked" });
		expect(toolResults[1]?.isError).toBe(true);
		expect(toolResults[1]?.text).toContain("Tool ask_like not found");
	});

	it.each([
		["a model without the flag", { supportsAllowedTools: false }],
		// senpi#3080: Responses-compatible gateways reject allowed_tools, so a flagged model behind one
		// gets only its active tools.
		["a flagged model behind a gateway", { supportsAllowedTools: true, baseUrl: "https://gateway.example.com/v1" }],
	])("sends only the active tools and rebuilds the prompt on %s", async (_label, options) => {
		const { requests, toolResults, askLikeRuns } = await runRemovalAndRestore(options);

		expect(requests).toHaveLength(4);
		expect(requests.map((request) => request.tools)).toEqual([
			TOOL_ORDER,
			["keep_read", "keep_write"],
			["keep_read", "keep_write"],
			["keep_read", "keep_write", "ask_like"],
		]);
		expect(requests.every((request) => request.activeToolNames === undefined)).toBe(true);
		expect(requests[0]?.systemPrompt).toContain("ask_like: Snippet for ask_like");
		expect(requests[1]?.systemPrompt).not.toContain("ask_like: Snippet for ask_like");

		expect(askLikeRuns).toBe(1);
		expect(toolResults[1]?.isError).toBe(true);
		expect(toolResults[1]?.text).toContain("Tool ask_like not found");
	});
});
