import { Type } from "typebox";
import { beforeEach, describe, expect, it } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { clearAllowedToolsChoiceRefusals } from "../src/api/openai-responses-allowed-tools.ts";
import { getModel } from "../src/compat.ts";
import { supportsAllowedToolChoice } from "../src/openai-responses-compat.ts";
import type { AssistantMessage, Model, Tool } from "../src/types.ts";
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

// The refusal observed on openai/gpt-6.1-sol (senpi#3080).
const ALLOWED_TOOLS_REFUSAL = {
	error: {
		message:
			"Invalid value: 'allowed_tools'. Supported values are: 'code_interpreter', 'programmatic_tool_calling', 'function', 'namespace', 'tool_search', 'file_search', 'web_search_preview', 'computer_use_preview', 'mcp', 'image_generation', 'custom', and 'apply_patch'.",
		type: "invalid_request_error",
		param: "tool_choice.type",
		code: "invalid_value",
	},
};

const COMPLETED_SSE = `data: ${JSON.stringify({
	type: "response.completed",
	sequence_number: 0,
	response: {
		id: "resp_ok",
		status: "completed",
		usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 } },
	},
})}\n\ndata: [DONE]\n\n`;

function sse(): Response {
	return new Response(COMPLETED_SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function jsonError(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function refusingAllowedTools(sent: CapturedPayload[]): typeof fetch {
	return async (_input, init) => {
		if (typeof init?.body !== "string") throw new Error("expected a JSON string request body");
		const body = JSON.parse(init.body) as CapturedPayload;
		sent.push(body);
		const choice = body.tool_choice as { type?: string } | undefined;
		return choice?.type === "allowed_tools" ? jsonError(400, ALLOWED_TOOLS_REFUSAL) : sse();
	};
}

async function runTurn(
	model: Model<"openai-responses">,
	fetchStub: typeof fetch,
	activeToolNames: string[],
	maxRetries = 0,
): Promise<AssistantMessage> {
	const events = streamOpenAIResponses(
		model,
		normalizeContext({
			systemPrompt: "sys",
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
			tools: TOOLS,
			activeToolNames,
		}),
		{ apiKey: "test-key", fetch: fetchStub, maxRetries, maxRetryDelayMs: 1 },
	);
	for await (const event of events) {
		if (event.type === "done") return event.message;
		if (event.type === "error") return event.error;
	}
	throw new Error("stream ended without done or error");
}

const toolNames = (payload: CapturedPayload) => payload.tools?.map((tool) => tool.name);
const choiceType = (payload: CapturedPayload | undefined) =>
	(payload?.tool_choice as { type?: string } | undefined)?.type;

// senpi#3080: an endpoint that rejects tool_choice allowed_tools must not fail every turn.
describe("openai-responses allowed_tools refusal", () => {
	const sol = getModel("openai", "gpt-6.1-sol");

	beforeEach(() => {
		clearAllowedToolsChoiceRefusals();
	});

	it("retries a refused allowed_tools request with only the active tools and no allowed_tools", async () => {
		const sent: CapturedPayload[] = [];
		const message = await runTurn(sol, refusingAllowedTools(sent), ["read", "bash"]);

		expect(message.stopReason).toBe("stop");
		expect(sent).toHaveLength(2);
		expect(choiceType(sent[0])).toBe("allowed_tools");
		expect(toolNames(sent[1] ?? {})).toEqual(["read", "bash"]);
		expect(sent[1]?.tool_choice).toBeUndefined();
	});

	it("sends the filtered shape directly on later turns to the same model", async () => {
		const sent: CapturedPayload[] = [];
		const fetchStub = refusingAllowedTools(sent);
		await runTurn(sol, fetchStub, ["read", "bash"]);
		sent.length = 0;

		const message = await runTurn(sol, fetchStub, ["read"]);

		expect(message.stopReason).toBe("stop");
		expect(sent).toHaveLength(1);
		expect(toolNames(sent[0] ?? {})).toEqual(["read"]);
		expect(sent[0]?.tool_choice).toBeUndefined();
	});

	it("forbids tool calls with tool_choice none after a refusal when no tool is active", async () => {
		const sent: CapturedPayload[] = [];
		const fetchStub = refusingAllowedTools(sent);
		await runTurn(sol, fetchStub, ["read", "bash"]);
		sent.length = 0;

		const message = await runTurn(sol, fetchStub, []);

		expect(message.stopReason).toBe("stop");
		expect(sent).toHaveLength(1);
		expect(sent[0]?.tool_choice).toBe("none");
	});

	it("resends the restricted request when an outer provider retry follows", async () => {
		const sent: CapturedPayload[] = [];
		let calls = 0;
		const fetchStub: typeof fetch = async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as CapturedPayload;
			sent.push(body);
			calls += 1;
			if (choiceType(body) === "allowed_tools") return jsonError(400, ALLOWED_TOOLS_REFUSAL);
			return calls === 2 ? jsonError(503, { error: { message: "overloaded", type: "server_error" } }) : sse();
		};

		const message = await runTurn(sol, fetchStub, ["read", "bash"], 1);

		expect(message.stopReason).toBe("stop");
		expect(sent.map(choiceType)).toEqual(["allowed_tools", undefined, undefined]);
		expect(toolNames(sent[2] ?? {})).toEqual(["read", "bash"]);
	});

	it("does not retry an unrelated 400", async () => {
		const sent: CapturedPayload[] = [];
		const fetchStub: typeof fetch = async (_input, init) => {
			sent.push(JSON.parse(String(init?.body)) as CapturedPayload);
			return jsonError(400, {
				error: { message: "Invalid value for 'input'.", type: "invalid_request_error", param: "input" },
			});
		};

		const message = await runTurn(sol, fetchStub, ["read", "bash"]);

		expect(message.stopReason).toBe("error");
		expect(sent).toHaveLength(1);
	});

	it("records nothing when the retry fails too", async () => {
		const sent: CapturedPayload[] = [];
		let calls = 0;
		const failingRetry: typeof fetch = async (_input, init) => {
			sent.push(JSON.parse(String(init?.body)) as CapturedPayload);
			calls += 1;
			return calls === 1
				? jsonError(400, ALLOWED_TOOLS_REFUSAL)
				: jsonError(500, { error: { message: "server error", type: "server_error" } });
		};
		const failed = await runTurn(sol, failingRetry, ["read", "bash"]);
		expect(failed.stopReason).toBe("error");
		expect(failed.errorMessage).toContain("server error");

		const next: CapturedPayload[] = [];
		await runTurn(sol, refusingAllowedTools(next), ["read", "bash"]);
		expect(choiceType(next[0])).toBe("allowed_tools");
	});
});

describe("openai-responses allowed_tools endpoint gate", () => {
	const sol = getModel("openai", "gpt-6.1-sol");
	const gateway: Model<"openai-responses"> = { ...sol, baseUrl: "https://gateway.example.com/v1" };

	beforeEach(() => {
		clearAllowedToolsChoiceRefusals();
	});

	it("restricts tools through allowed_tools only on the native OpenAI endpoint", () => {
		expect(sol.compat?.supportsAllowedTools).toBe(true);
		expect(supportsAllowedToolChoice(sol)).toBe(true);
		expect(supportsAllowedToolChoice(gateway)).toBe(false);
		expect(supportsAllowedToolChoice({ ...sol, baseUrl: "https://eu.api.openai.com/v1" })).toBe(true);
		expect(supportsAllowedToolChoice({ ...sol, baseUrl: "https://api.openai.com.gateway.example/v1" })).toBe(false);
	});

	it("never sends allowed_tools to a Responses-compatible gateway", async () => {
		const sent: CapturedPayload[] = [];

		const message = await runTurn(gateway, refusingAllowedTools(sent), ["read"]);

		expect(message.stopReason).toBe("stop");
		expect(sent).toHaveLength(1);
		expect(sent[0]?.tool_choice).toBeUndefined();
	});
});
