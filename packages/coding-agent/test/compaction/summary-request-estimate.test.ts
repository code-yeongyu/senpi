import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, Tool } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { estimateTokens } from "../../src/core/compaction/compaction.ts";
import { buildPrompt } from "../../src/core/extensions/builtin/compaction/prompts.ts";
import { estimateSummaryRequestTokens } from "../../src/core/extensions/builtin/compaction/speculative-summary.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

/**
 * Follow-ups to senpi#5905: the summary request estimate must count what the request sends when the transcript
 * carries no usage, must not trust usage that measured a context the request no longer carries, and must count
 * tool schemas activated after the last billed usage.
 */

const prompt = buildPrompt({ variant: "default" });

function user(text: string, timestamp = 1): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistantWithUsage(contextTokens: number, timestamp = 2): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Done." }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage: {
			input: contextTokens - 100,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: contextTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function toolResult(addedToolNames?: string[]): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "tool_search",
		content: [{ type: "text", text: "activated" }],
		isError: false,
		...(addedToolNames ? { addedToolNames } : {}),
		timestamp: 3,
	} as AgentMessage;
}

function tool(name: string, schemaChars: number): Tool {
	return {
		name,
		description: `The ${name} tool.`,
		parameters: { type: "object", properties: { input: { type: "string", description: "d".repeat(schemaChars) } } },
	} as unknown as Tool;
}

describe("estimateSummaryRequestTokens", () => {
	it("counts the system prompt and tool schemas when the transcript carries no usage", () => {
		const systemPrompt = `You are the agent. ${"s".repeat(160_000)}`;
		const tools = [tool("read", 20_000), tool("bash", 20_000)];
		const request = user("Summarize this short session.");

		const tokens = estimateSummaryRequestTokens({ systemPrompt, tools }, [request], prompt);

		const sentPrefixTokens = Math.ceil((systemPrompt.length + JSON.stringify(tools).length) / 4);
		expect(tokens).toBeGreaterThanOrEqual(sentPrefixTokens + estimateTokens(request));
	});

	it("does not trust usage from a message kept through an earlier compaction", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(user("Old request."));
		const keptId = sessionManager.appendMessage(assistantWithUsage(400_000));
		sessionManager.appendCompaction("Earlier summary.", keptId, 400_000, undefined, false);
		const messages = sessionManager.buildSessionContext().messages;
		const branch = sessionManager.getBranch();

		const stale = estimateSummaryRequestTokens({ branchEntries: branch }, messages, prompt);
		const current = estimateSummaryRequestTokens(
			{ branchEntries: branch.filter((entry) => entry.type !== "compaction") },
			messages,
			prompt,
		);

		expect(current).toBeGreaterThanOrEqual(400_000);
		expect(stale).toBeLessThan(10_000);
	});

	it("subtracts what pruning or input bounding cut before the usage it measured", () => {
		const oldHistory = user(`Old history. ${"h".repeat(40_000)}`);
		const source = [oldHistory, user("Latest request.", 2), assistantWithUsage(150_000, 3)];
		const bounded = source.slice(1);

		const untouched = estimateSummaryRequestTokens({}, source, prompt);
		const cut = estimateSummaryRequestTokens({}, bounded, prompt, source);

		expect(untouched).toBeGreaterThanOrEqual(150_000);
		expect(untouched - cut).toBe(estimateTokens(oldHistory));
	});

	it("counts tool schemas a tool result activated after the last usage", () => {
		const lazyTool = tool("lazy_tool", 40_000);
		const tools = [tool("read", 100), lazyTool];
		const transcript = (added?: string[]) => [user("Find a tool."), assistantWithUsage(10_000), toolResult(added)];

		const withActivation = estimateSummaryRequestTokens({ tools }, transcript(["lazy_tool"]), prompt);
		const withoutActivation = estimateSummaryRequestTokens({ tools }, transcript(), prompt);

		expect(withActivation - withoutActivation).toBe(Math.ceil(JSON.stringify([lazyTool]).length / 4));
	});
});
