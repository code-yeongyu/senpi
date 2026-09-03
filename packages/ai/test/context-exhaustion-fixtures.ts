import { MIN_ANSWER_TOKENS } from "../src/api/simple-options.ts";
import type { AssistantMessage, Context, Usage } from "../src/types.ts";
import { estimateContextTokens } from "../src/utils/estimate.ts";

export const CONTEXT_WINDOW = 10_000;
const CONTEXT_SAFETY_TOKENS = 4_096;
export const LAST_ADMITTED_ESTIMATE = CONTEXT_WINDOW - CONTEXT_SAFETY_TOKENS - MIN_ANSWER_TOKENS;
export const FIRST_EXHAUSTED_ESTIMATE = LAST_ADMITTED_ESTIMATE + 1;

function createUsage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(totalTokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "kept" }],
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		usage: createUsage(totalTokens),
		stopReason: "stop",
		timestamp: 100,
	};
}

export function contextWithEstimate(estimate: number): Context {
	const context: Context = {
		messages: [createAssistant(estimate - 1), { role: "user", content: "tail", timestamp: 200 }],
	};
	const actual = estimateContextTokens(context).tokens;
	if (actual !== estimate) throw new Error(`fixture estimate drifted: expected ${estimate}, got ${actual}`);
	return context;
}
