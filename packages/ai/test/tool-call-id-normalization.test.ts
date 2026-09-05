/**
 * Tool Call ID Normalization Tests
 *
 * Tests that tool call IDs from OpenAI Responses API (github-copilot, openai-codex, opencode)
 * are properly normalized when sent to other providers.
 *
 * OpenAI Responses API generates IDs in format: {call_id}|{id}
 * where {id} can be 400+ chars with special characters (+, /, =).
 *
 * Regression test for: https://github.com/earendil-works/pi-mono/issues/1022
 */

import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { completeSimple, getModel, getModels } from "../src/compat.ts";
import type { AssistantMessage, Message, Tool, ToolResultMessage } from "../src/types.ts";
import { getLiveEnvApiKey, OPENROUTER_LIVE_TEST_FLAG } from "./live-api-gates.ts";
import { resolveApiKey } from "./oauth.ts";

const COPILOT_CODEX_MISSING = "github-copilot catalog has no codex-family model; update the test";
const OPENROUTER_CODEX_MISSING = "openrouter catalog has no openai gpt-5 codex-family model; update the test";

/**
 * Pick a catalog model by id family so tests never pin a ModelId literal.
 * Release-time generate-models rewrites the ModelId union from models.dev;
 * a retired pin fails tsc even when the live test is skipIf-gated.
 */
function requireCatalogModel<T extends { id: string }>(
	models: readonly T[],
	idPattern: RegExp,
	missingMessage: string,
): T {
	const model = models.find((candidate) => idPattern.test(candidate.id));
	if (!model) {
		throw new Error(missingMessage);
	}
	return model;
}

function requireCopilotCodexModel() {
	return requireCatalogModel(getModels("github-copilot"), /codex/i, COPILOT_CODEX_MISSING);
}

function requireOpenrouterGpt5CodexModel() {
	return requireCatalogModel(getModels("openrouter"), /openai\/gpt-5.*codex/, OPENROUTER_CODEX_MISSING);
}

// Resolve API keys
const copilotToken = await resolveApiKey("github-copilot");
const openrouterKey = getLiveEnvApiKey("OPENROUTER_API_KEY", OPENROUTER_LIVE_TEST_FLAG);
const codexToken = await resolveApiKey("openai-codex");

// Simple echo tool for testing
const echoToolSchema = Type.Object({
	message: Type.String({ description: "Message to echo back" }),
});

const echoTool: Tool<typeof echoToolSchema> = {
	name: "echo",
	description: "Echoes the message back",
	parameters: echoToolSchema,
};

describe("Tool Call ID Normalization - catalog model selection", () => {
	it("selects a github-copilot codex-family model from the committed catalog", () => {
		expect(requireCopilotCodexModel().id).toMatch(/codex/i);
	});

	it("throws when a provider has no codex-family model", () => {
		expect(() => requireCatalogModel([] as Array<{ id: string }>, /codex/i, COPILOT_CODEX_MISSING)).toThrow(
			COPILOT_CODEX_MISSING,
		);
	});
});

/**
 * Test 1: Live cross-provider handoff
 *
 * 1. Use a github-copilot codex-family model (catalog-selected, not a pinned ModelId) to generate a tool call
 * 2. Switch to an openrouter openai gpt-5*codex model and complete
 * 3. Switch to openai-codex gpt-5.5 and complete
 *
 * Both should succeed without "call_id too long" errors.
 */
describe("Tool Call ID Normalization - Live Handoff", () => {
	it.skipIf(!copilotToken || !openrouterKey)(
		"github-copilot -> openrouter should normalize pipe-separated IDs",
		async () => {
			const copilotModel = requireCopilotCodexModel();
			const openrouterModel = requireOpenrouterGpt5CodexModel();

			// Step 1: Generate tool call with github-copilot
			const userMessage: Message = {
				role: "user",
				content: "Use the echo tool to echo 'hello world'",
				timestamp: Date.now(),
			};

			const assistantResponse = await completeSimple(
				copilotModel,
				{
					systemPrompt: "You are a helpful assistant. Use the echo tool when asked.",
					messages: [userMessage],
					tools: [echoTool],
				},
				{ apiKey: copilotToken },
			);

			expect(assistantResponse.stopReason, `Copilot error: ${assistantResponse.errorMessage}`).toBe("toolUse");

			const toolCall = assistantResponse.content.find((c) => c.type === "toolCall");
			expect(toolCall).toBeDefined();
			expect(toolCall!.type).toBe("toolCall");

			// Verify it's a pipe-separated ID (OpenAI Responses format)
			if (toolCall?.type === "toolCall") {
				expect(toolCall.id).toContain("|");
				console.log(`Tool call ID from github-copilot: ${toolCall.id.slice(0, 80)}...`);
			}

			// Create tool result
			const toolResult: ToolResultMessage = {
				role: "toolResult",
				toolCallId: (toolCall as any).id,
				toolName: "echo",
				content: [{ type: "text", text: "hello world" }],
				isError: false,
				timestamp: Date.now(),
			};

			// Step 2: Complete with openrouter (uses openai-completions API)
			const openrouterResponse = await completeSimple(
				openrouterModel,
				{
					systemPrompt: "You are a helpful assistant.",
					messages: [
						userMessage,
						assistantResponse,
						toolResult,
						{ role: "user", content: "Say hi", timestamp: Date.now() },
					],
					tools: [echoTool],
				},
				{ apiKey: openrouterKey, reasoning: "high" },
			);

			// Should NOT fail with "call_id too long" error
			expect(openrouterResponse.stopReason, `OpenRouter error: ${openrouterResponse.errorMessage}`).not.toBe(
				"error",
			);
			expect(openrouterResponse.errorMessage).toBeUndefined();
		},
		60000,
	);

	it.skipIf(!copilotToken || !codexToken)(
		"github-copilot -> openai-codex should normalize pipe-separated IDs",
		async () => {
			const copilotModel = requireCopilotCodexModel();
			const codexModel = getModel("openai-codex", "gpt-5.5");

			// Step 1: Generate tool call with github-copilot
			const userMessage: Message = {
				role: "user",
				content: "Use the echo tool to echo 'test message'",
				timestamp: Date.now(),
			};

			const assistantResponse = await completeSimple(
				copilotModel,
				{
					systemPrompt: "You are a helpful assistant. Use the echo tool when asked.",
					messages: [userMessage],
					tools: [echoTool],
				},
				{ apiKey: copilotToken },
			);

			expect(assistantResponse.stopReason, `Copilot error: ${assistantResponse.errorMessage}`).toBe("toolUse");

			const toolCall = assistantResponse.content.find((c) => c.type === "toolCall");
			expect(toolCall).toBeDefined();

			// Create tool result
			const toolResult: ToolResultMessage = {
				role: "toolResult",
				toolCallId: (toolCall as any).id,
				toolName: "echo",
				content: [{ type: "text", text: "test message" }],
				isError: false,
				timestamp: Date.now(),
			};

			// Step 2: Complete with openai-codex (uses openai-codex-responses API)
			const codexResponse = await completeSimple(
				codexModel,
				{
					systemPrompt: "You are a helpful assistant.",
					messages: [
						userMessage,
						assistantResponse,
						toolResult,
						{ role: "user", content: "Say hi", timestamp: Date.now() },
					],
					tools: [echoTool],
				},
				{ apiKey: codexToken },
			);

			// Should NOT fail with ID validation error
			expect(codexResponse.stopReason, `Codex error: ${codexResponse.errorMessage}`).not.toBe("error");
			expect(codexResponse.errorMessage).toBeUndefined();
		},
		60000,
	);
});

/**
 * Test 2: Prefilled context with exact failing IDs from issue #1022
 *
 * Uses the exact tool call ID format that caused the error:
 * "call_xxx|very_long_base64_with_special_chars+/="
 */
describe("Tool Call ID Normalization - Prefilled Context", () => {
	// Exact tool call ID from issue #1022 JSONL
	const FAILING_TOOL_CALL_ID =
		"call_pAYbIr76hXIjncD9UE4eGfnS|t5nnb2qYMFWGSsr13fhCd1CaCu3t3qONEPuOudu4HSVEtA8YJSL6FAZUxvoOoD792VIJWl91g87EdqsCWp9krVsdBysQoDaf9lMCLb8BS4EYi4gQd5kBQBYLlgD71PYwvf+TbMD9J9/5OMD42oxSRj8H+vRf78/l2Xla33LWz4nOgsddBlbvabICRs8GHt5C9PK5keFtzyi3lsyVKNlfduK3iphsZqs4MLv4zyGJnvZo/+QzShyk5xnMSQX/f98+aEoNflEApCdEOXipipgeiNWnpFSHbcwmMkZoJhURNu+JEz3xCh1mrXeYoN5o+trLL3IXJacSsLYXDrYTipZZbJFRPAucgbnjYBC+/ZzJOfkwCs+Gkw7EoZR7ZQgJ8ma+9586n4tT4cI8DEhBSZsWMjrCt8dxKg==";

	// Build prefilled context with the failing ID
	function buildPrefilledMessages(): Message[] {
		const userMessage: Message = {
			role: "user",
			content: "Use the echo tool to echo 'hello'",
			timestamp: Date.now() - 2000,
		};

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: FAILING_TOOL_CALL_ID,
					name: "echo",
					arguments: { message: "hello" },
				},
			],
			api: "openai-responses",
			provider: "github-copilot",
			model: "gpt-5.2-codex",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now() - 1500,
		};

		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: FAILING_TOOL_CALL_ID,
			toolName: "echo",
			content: [{ type: "text", text: "hello" }],
			isError: false,
			timestamp: Date.now() - 1000,
		};

		const followUpUser: Message = {
			role: "user",
			content: "Say hi",
			timestamp: Date.now(),
		};

		return [userMessage, assistantMessage, toolResult, followUpUser];
	}

	it.skipIf(!openrouterKey)(
		"openrouter should handle prefilled context with long pipe-separated IDs",
		async () => {
			const model = requireOpenrouterGpt5CodexModel();
			const messages = buildPrefilledMessages();

			const response = await completeSimple(
				model,
				{
					systemPrompt: "You are a helpful assistant.",
					messages,
					tools: [echoTool],
				},
				{ apiKey: openrouterKey, reasoning: "high" },
			);

			// Should NOT fail with "call_id too long" error
			expect(response.stopReason, `OpenRouter error: ${response.errorMessage}`).not.toBe("error");
			if (response.errorMessage) {
				expect(response.errorMessage).not.toContain("call_id");
				expect(response.errorMessage).not.toContain("too long");
			}
		},
		30000,
	);

	it.skipIf(!codexToken)(
		"openai-codex should handle prefilled context with long pipe-separated IDs",
		async () => {
			const model = getModel("openai-codex", "gpt-5.5");
			const messages = buildPrefilledMessages();

			const response = await completeSimple(
				model,
				{
					systemPrompt: "You are a helpful assistant.",
					messages,
					tools: [echoTool],
				},
				{ apiKey: codexToken },
			);

			// Should NOT fail with ID validation error
			expect(response.stopReason, `Codex error: ${response.errorMessage}`).not.toBe("error");
			if (response.errorMessage) {
				expect(response.errorMessage).not.toContain("id");
				expect(response.errorMessage).not.toContain("additional characters");
			}
		},
		30000,
	);
});
