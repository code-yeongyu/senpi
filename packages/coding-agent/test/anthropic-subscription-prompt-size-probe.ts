import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { buildPromptBlocks } from "../src/core/extensions/builtin/anthropic-subscription/prompt-bridge.ts";
import { dedupeUltraworkBlocks } from "../src/core/extensions/builtin/anthropic-subscription/prompt-directive-dedupe.ts";

const OPEN = "<ultrawork-mode>";
const CLOSE = "</ultrawork-mode>";
const DIRECTIVE_BODY = "x".repeat(17_000);
const DIRECTIVE_BLOCK = `${OPEN}${DIRECTIVE_BODY}${CLOSE}`;

function assistantTurn(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "claude-sdk-oauth",
		provider: "anthropic-subscription",
		model: "claude-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

export function buildUlwHeavyContext(copies: number, turns: number): Context {
	const messages: Context["messages"] = [];
	let placed = 0;
	for (let t = 1; t <= turns; t += 1) {
		const userText = placed < copies ? `${DIRECTIVE_BLOCK}\nuser turn ${t}` : `user turn ${t}`;
		if (placed < copies) placed += 1;
		messages.push({ role: "user", content: userText, timestamp: t * 2 - 1 });
		messages.push(assistantTurn(`assistant turn ${t}`, t * 2));
	}
	return { messages };
}

export interface SerializedPromptMetrics {
	totalBytes: number;
	directiveBlockCount: number;
}

const SPAN_PATTERN = /<ultrawork-mode>[\s\S]*?<\/ultrawork-mode>/g;

export function measureSerializedPrompt(context: Context, dedupe: boolean): SerializedPromptMetrics {
	const built = buildPromptBlocks(context);
	const result = dedupe ? dedupeUltraworkBlocks(built) : { blocks: built, collapsedDirectives: 0 };
	let totalBytes = 0;
	let directiveBlockCount = 0;
	for (const block of result.blocks) {
		if (block.type === "text") {
			totalBytes += block.text.length;
			directiveBlockCount += (block.text.match(SPAN_PATTERN) ?? []).length;
		}
	}
	return { totalBytes, directiveBlockCount };
}
