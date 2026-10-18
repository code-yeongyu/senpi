import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { isTurnStuckOnContextOverflow } from "../../src/core/compaction/stuck-overflow.ts";

const CONTEXT_WINDOW = 1_000;

function assistant(
	overrides: Partial<AssistantMessage> & Pick<AssistantMessage, "stopReason">,
	tokens: { input: number; output: number },
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-6-astra",
		usage: {
			input: tokens.input,
			output: tokens.output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: tokens.input + tokens.output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 0,
		...overrides,
	};
}

describe("isTurnStuckOnContextOverflow", () => {
	it("is stuck when the provider rejected the request as a context overflow", () => {
		//#given
		const rejected = assistant(
			{ stopReason: "error", errorMessage: "Your input exceeds the context window of this model." },
			{ input: 0, output: 0 },
		);

		//#when / then
		expect(isTurnStuckOnContextOverflow(rejected, CONTEXT_WINDOW)).toBe(true);
	});

	it("is stuck when a truncating provider filled the window and produced no output", () => {
		//#given
		const truncated = assistant({ stopReason: "length" }, { input: CONTEXT_WINDOW, output: 0 });

		//#when / then
		expect(isTurnStuckOnContextOverflow(truncated, CONTEXT_WINDOW)).toBe(true);
	});

	it("is not stuck when a completed answer merely reports usage past the window", () => {
		//#given - z.ai style silent overflow: the request was accepted and answered
		const answered = assistant({ stopReason: "stop" }, { input: CONTEXT_WINDOW + 1, output: 50 });

		//#when / then
		expect(isTurnStuckOnContextOverflow(answered, CONTEXT_WINDOW)).toBe(false);
	});

	it("is not stuck for an unrelated provider error", () => {
		//#given
		const overloaded = assistant(
			{ stopReason: "error", errorMessage: "server_is_overloaded: Our servers are currently overloaded." },
			{ input: 0, output: 0 },
		);

		//#when / then
		expect(isTurnStuckOnContextOverflow(overloaded, CONTEXT_WINDOW)).toBe(false);
	});
});
