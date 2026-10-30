import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	boundSummarizationInput,
	estimateTotalTokens,
	shrinkSummarizationInputForOverflowRetry,
	summarizationHistoryBudget,
} from "../../src/core/extensions/builtin/compaction/overflow-retry.ts";

/**
 * senpi#4079: the summarization bound is shared by core and the builtin compaction. When one turn alone is over the
 * budget, it keeps that turn's request and drops the turn's oldest tool steps, never a call without its result.
 */
const CONTEXT_WINDOW = 8_000;
const STEP_TEXT = "x".repeat(1_200);

function oneLongTurn(steps: number): AgentMessage[] {
	const messages: AgentMessage[] = [{ role: "user", content: "the turn's request", timestamp: 0 }];
	for (let step = 0; step < steps; step++) {
		messages.push({
			role: "assistant",
			content: [
				{ type: "text", text: `step ${step} ${STEP_TEXT}` },
				{ type: "toolCall", id: `call-${step}`, name: "read", arguments: { path: `file-${step}` } },
			],
			api: "faux",
			provider: "faux",
			model: "faux",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: step * 2 + 1,
		});
		messages.push({
			role: "toolResult",
			toolCallId: `call-${step}`,
			toolName: "read",
			content: [{ type: "text", text: `contents ${step}` }],
			isError: false,
			timestamp: step * 2 + 2,
		});
	}
	return messages;
}

function toolCallIds(messages: AgentMessage[]): string[] {
	return messages.flatMap((message) =>
		message.role === "assistant"
			? message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []))
			: [],
	);
}

function toolResultIds(messages: AgentMessage[]): string[] {
	return messages.flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : []));
}

function userText(message: AgentMessage | undefined): string {
	if (message?.role !== "user") return "";
	return typeof message.content === "string"
		? message.content
		: message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

describe("#4079 the summarization bound inside one long turn", () => {
	it("#given one turn over the budget #when the input is bounded #then the request stays, the oldest tool steps go, and no call loses its result", () => {
		// given
		const turn = oneLongTurn(30);

		// when
		const bounded = boundSummarizationInput(turn, CONTEXT_WINDOW, 100);

		// then
		expect(bounded.length).toBeLessThan(turn.length);
		expect(bounded[0]).toBe(turn[0]);
		expect(toolCallIds(bounded)).toEqual(toolResultIds(bounded));
		expect(bounded.at(-1)).toBe(turn.at(-1));
	});

	it("#given only the request and plain replies remain #when an overflow retry shrinks the input #then the request is kept", () => {
		// given
		const request: AgentMessage = { role: "user", content: "the turn's request", timestamp: 0 };
		const replies = oneLongTurn(2)
			.filter((message) => message.role === "assistant")
			.map((message) => ({
				...message,
				content: message.content.filter((block) => block.type === "text"),
				stopReason: "stop" as const,
			}));

		// when
		const shrunk = shrinkSummarizationInputForOverflowRetry([request, ...replies], CONTEXT_WINDOW, 100);

		// then
		expect(shrunk?.[0]).toBe(request);
		expect(shrunk).toHaveLength(2);
	});
	it("#given a request that alone is over the budget #when the input is bounded #then the request is kept but truncated so the input fits", () => {
		// given
		const request: AgentMessage = { role: "user", content: `pasted log ${"y".repeat(200_000)}`, timestamp: 0 };
		const replies = oneLongTurn(2)
			.filter((message) => message.role === "assistant")
			.map((message) => ({
				...message,
				content: message.content.filter((block) => block.type === "text"),
				stopReason: "stop" as const,
			}));

		// when
		const bounded = boundSummarizationInput([request, ...replies], CONTEXT_WINDOW, 100);

		// then
		expect(bounded[0]?.role).toBe("user");
		expect(userText(bounded[0])).toMatch(/^pasted log y+/);
		expect(userText(bounded[0])).toContain("more characters truncated");
		expect(estimateTotalTokens(bounded)).toBeLessThanOrEqual(summarizationHistoryBudget(CONTEXT_WINDOW, 100));
	});

	it("#given a request that alone is over the budget #when an overflow retry shrinks the input #then it truncates the request instead of giving up", () => {
		// given
		const request: AgentMessage = { role: "user", content: `pasted log ${"y".repeat(200_000)}`, timestamp: 0 };

		// when
		const shrunk = shrinkSummarizationInputForOverflowRetry([request], CONTEXT_WINDOW, 100);

		// then
		expect(shrunk).toHaveLength(1);
		expect(userText(shrunk?.[0])).toContain("more characters truncated");
		expect(estimateTotalTokens(shrunk ?? [])).toBeLessThanOrEqual(summarizationHistoryBudget(CONTEXT_WINDOW, 100));
	});
	it("#given a turn that starts with a custom message and no request #when the input is bounded #then it never comes back empty", () => {
		// given: no user-like message, so nothing anchors the request
		const start: AgentMessage = {
			role: "custom",
			customType: "turn-start",
			content: "start",
			display: false,
			timestamp: 0,
		} as AgentMessage;
		const reply = oneLongTurn(1).filter((message) => message.role === "assistant")[0];
		const bigReply = {
			...reply,
			content: [{ type: "text" as const, text: "z".repeat(400_000) }],
			stopReason: "stop" as const,
		} as AgentMessage;

		// when
		const bounded = boundSummarizationInput([start, bigReply], 100_000, 100);

		// then
		expect(bounded.length).toBeGreaterThan(0);
		expect(bounded.at(-1)).toBe(bigReply);
	});
	it("#given a request already cut by an earlier retry #when the next retry cuts it again #then it carries one note with the combined count", () => {
		// given
		const original = `pasted log ${"y".repeat(200_000)}`;
		const request: AgentMessage = { role: "user", content: original, timestamp: 0 };
		const once = shrinkSummarizationInputForOverflowRetry([request], CONTEXT_WINDOW, 100) ?? [];

		// when
		const twice = shrinkSummarizationInputForOverflowRetry(once, CONTEXT_WINDOW, 100) ?? [];

		// then
		const text = userText(twice[0]);
		expect(text.match(/more characters truncated/g)).toHaveLength(1);
		const kept = text.slice(0, text.indexOf("\n\n[... "));
		const cut = Number(/\[\.\.\. (\d+) more characters truncated\]$/.exec(text)?.[1]);
		expect(kept.length + cut).toBe(original.length);
	});
});
