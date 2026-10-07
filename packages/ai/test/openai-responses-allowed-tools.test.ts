import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Context, Model, Tool } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

interface CapturedPayload {
	tools?: Array<{ type: string; name?: string }>;
	tool_choice?: unknown;
}

const TOOLS: Tool[] = ["read", "ask_user", "bash"].map((name) => ({
	name,
	description: `${name} tool`,
	parameters: Type.Object({}),
}));

function withAllowedTools(model: Model<"openai-responses">, supportsAllowedTools: boolean): Model<"openai-responses"> {
	return { ...model, compat: { ...model.compat, supportsAllowedTools } };
}

async function captureRequestBody(
	model: Model<"openai-responses">,
	context: Omit<Context, "systemPrompt" | "messages"> & Partial<Pick<Context, "messages">>,
	options?: { toolChoice?: "auto" | "required"; onPayload?: (payload: unknown) => unknown },
): Promise<CapturedPayload> {
	let body: CapturedPayload | undefined;
	const fetchStub: typeof fetch = async (_input, init) => {
		if (typeof init?.body !== "string") throw new Error("expected a JSON string request body");
		body = JSON.parse(init.body) as CapturedPayload;
		return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	const events = streamOpenAIResponses(
		model,
		normalizeContext({ systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: 1 }], ...context }),
		{ apiKey: "test-key", fetch: fetchStub, toolChoice: options?.toolChoice, onPayload: options?.onPayload },
	);
	for await (const event of events) {
		if (event.type === "done" || event.type === "error") break;
	}
	if (body === undefined) throw new Error("request was not sent");
	return body;
}

const toolNames = (payload: CapturedPayload) => payload.tools?.map((tool) => tool.name);

// senpi#2095: removing a tool must not rewrite the cached `tools` prefix on models that accept allowed_tools.
describe("openai-responses allowed_tools restriction", () => {
	const luna = getModel("openai", "gpt-6-luna");
	const flagged = withAllowedTools(luna, true);

	it("marks the GPT-5.6+ OpenAI catalog rows as accepting allowed_tools", () => {
		expect(luna.compat?.supportsAllowedTools).toBe(true);
		expect(getModel("openai", "gpt-5.5").compat?.supportsAllowedTools).not.toBe(true);
	});

	it("keeps every declared tool and restricts the active subset through tool_choice", async () => {
		const payload = await captureRequestBody(flagged, { tools: TOOLS, activeToolNames: ["read", "bash"] });

		expect(toolNames(payload)).toEqual(["read", "ask_user", "bash"]);
		expect(payload.tool_choice).toEqual({
			type: "allowed_tools",
			mode: "auto",
			tools: [
				{ type: "function", name: "read" },
				{ type: "function", name: "bash" },
			],
		});
	});

	it("sends no tool_choice when every declared tool is active", async () => {
		const payload = await captureRequestBody(flagged, {
			tools: TOOLS,
			activeToolNames: ["bash", "read", "ask_user"],
		});

		expect(toolNames(payload)).toEqual(["read", "ask_user", "bash"]);
		expect(payload.tool_choice).toBeUndefined();
	});

	it("forbids tool calls with tool_choice none when the active subset is empty", async () => {
		const payload = await captureRequestBody(flagged, { tools: TOOLS, activeToolNames: [] });

		expect(toolNames(payload)).toEqual(["read", "ask_user", "bash"]);
		expect(payload.tool_choice).toBe("none");
	});

	it("lets an explicit toolChoice win over the active subset", async () => {
		const payload = await captureRequestBody(
			flagged,
			{ tools: TOOLS, activeToolNames: ["read"] },
			{ toolChoice: "required" },
		);

		expect(payload.tool_choice).toBe("required");
	});

	it("ignores the active subset on a model without the compat flag", async () => {
		const payload = await captureRequestBody(withAllowedTools(luna, false), {
			tools: TOOLS,
			activeToolNames: ["read"],
		});

		expect(toolNames(payload)).toEqual(["read", "ask_user", "bash"]);
		expect(payload.tool_choice).toBeUndefined();
	});

	it("does not reference a declared tool that a payload hook removed from tools", async () => {
		const webSearch: Tool = { name: "web_search", description: "web_search tool", parameters: Type.Object({}) };
		const swapInHostedWebSearch = (payload: unknown) => {
			const body = payload as { tools: Array<{ type: string; name?: string }> };
			return {
				...body,
				tools: [...body.tools.filter((tool) => tool.name !== "web_search"), { type: "web_search_preview" }],
			};
		};
		const payload = await captureRequestBody(
			flagged,
			{ tools: [...TOOLS, webSearch], activeToolNames: ["read", "web_search"] },
			{ onPayload: swapInHostedWebSearch },
		);

		expect(toolNames(payload)).toEqual(["read", "ask_user", "bash", undefined]);
		expect(payload.tool_choice).toEqual({
			type: "allowed_tools",
			mode: "auto",
			tools: [{ type: "function", name: "read" }, { type: "web_search_preview" }],
		});
	});

	it("references an active deferred tool that the transcript declares", async () => {
		const lateTool: Tool = { name: "late_tool", description: "late_tool tool", parameters: Type.Object({}) };
		const readCall: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-6",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		};
		const payload = await captureRequestBody(flagged, {
			tools: [...TOOLS, lateTool],
			activeToolNames: ["read", "late_tool"],
			messages: [
				{ role: "user", content: "hi", timestamp: 1 },
				readCall,
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "read",
					content: [{ type: "text", text: "done" }],
					addedToolNames: ["late_tool"],
					isError: false,
					timestamp: 3,
				},
				{ role: "user", content: "next", timestamp: 4 },
			],
		});

		expect(toolNames(payload)).toEqual(["read", "ask_user", "bash"]);
		expect(payload.tool_choice).toEqual({
			type: "allowed_tools",
			mode: "auto",
			tools: [
				{ type: "function", name: "read" },
				{ type: "function", name: "late_tool" },
			],
		});
	});
});
