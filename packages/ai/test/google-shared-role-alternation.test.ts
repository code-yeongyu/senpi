import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/api/google-shared.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// Regression for #2114: Gemini expects user and model turns to alternate, so adjacent same-role turns are folded.
// Folded user turns keep functionResponse parts last on Gemini 3+: Vertex rejects [functionResponse, text] as
// "Requests ending with a model turn are not supported" while [text, functionResponse] returns 200 (omo#9747, senpi#3633).

const VALID_SIG = "AAAAAAAAAAAAAAAAAAAAAA==";

const model: Model<"google-generative-ai"> = {
	id: "gemini-3-pro-preview",
	name: "Gemini 3 Pro Preview",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "https://generativelanguage.googleapis.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000000,
	maxTokens: 8192,
};

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

describe("google-shared role alternation (#2114)", () => {
	it("folds the environment-context user message and the prompt into one user turn", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "<environment_context>cwd: /repo</environment_context>", timestamp: Date.now() },
				{
					role: "user",
					content: [
						{ type: "text", text: "Fix the bug" },
						{ type: "image", mimeType: "image/png", data: "aGVsbG8=" },
					],
					timestamp: Date.now(),
				},
			],
		};

		const contents = convertMessages(model, normalizeContext(context));

		expect(contents).toEqual([
			{
				role: "user",
				parts: [
					{ text: "<environment_context>cwd: /repo</environment_context>" },
					{ text: "Fix the bug" },
					{ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } },
				],
			},
		]);
	});

	it("folds a user prompt that follows tool results ahead of the function response", () => {
		// The trailing prompt must land before the functionResponse part: [text, functionResponse] is the
		// measured-good shape (omo#9747, senpi#3633). The call carries a valid signature so the turn
		// stays structured and the part order is what is asserted.
		const context: Context = {
			messages: [
				{ role: "user", content: "Read the file", timestamp: Date.now() },
				assistant([
					{
						type: "toolCall",
						id: "call_a",
						name: "read",
						arguments: { path: "a.txt" },
						thoughtSignature: VALID_SIG,
					},
				]),
				{
					role: "toolResult",
					toolCallId: "call_a",
					toolName: "read",
					content: [{ type: "text", text: "alpha" }],
					isError: false,
					timestamp: Date.now(),
				},
				{ role: "user", content: "Now summarize it", timestamp: Date.now() },
			],
		};

		const contents = convertMessages(model, normalizeContext(context));

		expect(contents.map((content) => content.role)).toEqual(["user", "model", "user"]);
		const parts = contents[2].parts ?? [];
		expect(parts).toHaveLength(2);
		expect(parts[0]).toEqual({ text: "Now summarize it" });
		expect(parts[1]?.functionResponse?.response).toEqual({ output: "alpha" });
	});

	it("orders a detached-tool reminder ahead of consecutive function responses (omo#9747)", () => {
		// A <system-reminder> notification for a detached or cancelled tool arrives as a user
		// message right after the tool results; folded into one user turn, every functionResponse
		// must trail it or Vertex answers 400 "Requests ending with a model turn are not supported".
		const argon: Model<"google-vertex"> = {
			id: "gemini-4-argon",
			name: "Gemini 4 Argon",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: "https://example.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const argonAssistant = (content: AssistantMessage["content"]): AssistantMessage => ({
			role: "assistant",
			content,
			api: argon.api,
			provider: argon.provider,
			model: argon.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		});
		const evalResult = (id: string, text: string) => ({
			role: "toolResult" as const,
			toolCallId: id,
			toolName: "eval",
			content: [{ type: "text" as const, text }],
			isError: false,
			timestamp: Date.now(),
		});
		const context: Context = {
			messages: [
				{ role: "user", content: "run the evals", timestamp: Date.now() },
				// Parallel calls carry the signature on the first part only; the turn stays structured.
				argonAssistant([
					{
						type: "toolCall",
						id: "call_e1",
						name: "eval",
						arguments: { code: "1+1" },
						thoughtSignature: VALID_SIG,
					},
					{ type: "toolCall", id: "call_e2", name: "eval", arguments: { code: "2+2" } },
				]),
				evalResult("call_e1", "cell detached"),
				evalResult("call_e2", "cell cancelled"),
				{
					role: "user",
					content: "<system-reminder>Detached eval cell call_e1 (js) was cancelled</system-reminder>",
					timestamp: Date.now(),
				},
			],
		};

		const contents = convertMessages(argon, normalizeContext(context));

		const lastTurn = contents[contents.length - 1];
		expect(lastTurn?.role).toBe("user");
		const partKinds = (lastTurn?.parts ?? []).map((part) =>
			part.functionResponse !== undefined ? "fr" : part.text !== undefined ? "text" : "other",
		);
		expect(partKinds).toEqual(["text", "fr", "fr"]);
		expect(lastTurn?.parts?.[0]?.text).toContain("<system-reminder>");
		expect(lastTurn?.parts?.[1]?.functionResponse?.id).toBe("call_e1");
		expect(lastTurn?.parts?.[2]?.functionResponse?.id).toBe("call_e2");
	});

	it("keeps the folded Gemini 2 order unchanged", () => {
		// Gemini 2 accepts text after functionResponse (senpi#3633: gemini-2.5-pro finishes the
		// same transcript), so its wire bytes stay [functionResponse, text]; the reorder is
		// limited to the generations that reject the trailing-text shape.
		const gemini2: Model<"google-generative-ai"> = { ...model, id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" };
		const gemini2Assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
			role: "assistant",
			content,
			api: gemini2.api,
			provider: gemini2.provider,
			model: gemini2.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		});
		const context: Context = {
			messages: [
				{ role: "user", content: "Read the file", timestamp: Date.now() },
				gemini2Assistant([
					{
						type: "toolCall",
						id: "call_a",
						name: "read",
						arguments: { path: "a.txt" },
						thoughtSignature: VALID_SIG,
					},
				]),
				{
					role: "toolResult",
					toolCallId: "call_a",
					toolName: "read",
					content: [{ type: "text", text: "alpha" }],
					isError: false,
					timestamp: Date.now(),
				},
				{ role: "user", content: "Now summarize it", timestamp: Date.now() },
			],
		};

		const contents = convertMessages(gemini2, normalizeContext(context));

		const parts = contents[2].parts ?? [];
		expect(parts).toHaveLength(2);
		expect(parts[0]?.functionResponse?.response).toEqual({ output: "alpha" });
		expect(parts[1]).toEqual({ text: "Now summarize it" });
	});

	it("leaves an already alternating conversation unchanged", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "Hi", timestamp: Date.now() },
				assistant([{ type: "text", text: "Hello" }]),
				{ role: "user", content: "Bye", timestamp: Date.now() },
			],
		};

		const contents = convertMessages(model, normalizeContext(context));

		expect(contents).toEqual([
			{ role: "user", parts: [{ text: "Hi" }] },
			{ role: "model", parts: [{ text: "Hello" }] },
			{ role: "user", parts: [{ text: "Bye" }] },
		]);
	});
});
