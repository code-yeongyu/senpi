// Regression coverage for senpi issue #1603: the Cursor admission pass used a
// fixed 50 KB aggregate budget and deleted whole conversation turns to reach
// it, so a 1M-token window kept ~6K tokens of history. Admission must never
// delete a turn; it caps tool result bodies against the model's real window and
// hands an over-budget history to the existing overflow -> compaction path.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	recordCursorContextLimit,
	resetCursorContextLimitStoreForTest,
} from "@earendil-works/pi-ai/utils/cursor-context-limit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { admitCursorHistory, cursorAdmissionBudgetBytes } from "../../../src/core/cursor-history-admission.ts";
import { createHarness, type Harness } from "../harness.ts";

// Observed ceilings persist to disk; keep this suite out of the real agent dir.
process.env.CURSOR_CONTEXT_LIMIT_STORE = join(mkdtempSync(join(tmpdir(), "cursor-limits-")), "limits.json");

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 0 } as AgentMessage;
}

function assistantMessage(text: string, toolCallId?: string): AgentMessage {
	return {
		role: "assistant",
		content:
			toolCallId === undefined
				? [{ type: "text", text }]
				: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "a.ts" } }],
		api: "cursor-agent",
		provider: "cursor",
		model: "kimi-k3",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: toolCallId === undefined ? "stop" : "toolUse",
		timestamp: 0,
	} as AgentMessage;
}

function toolResultMessage(text: string, toolCallId: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	} as AgentMessage;
}

/** `turnCount` turns of `user -> assistant(toolCall) -> toolResult`, plus a live user turn. */
function pairedToolTurns(turnCount: number, resultText: string): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (let index = 0; index < turnCount; index++) {
		const toolCallId = `call-${index}`;
		messages.push(userMessage(`request ${index}`));
		messages.push(assistantMessage("", toolCallId));
		messages.push(toolResultMessage(resultText, toolCallId));
	}
	messages.push(userMessage("continue"));
	return messages;
}

function toolResultTexts(messages: AgentMessage[]): string[] {
	return messages.flatMap((message) =>
		message.role === "toolResult"
			? message.content.filter((part) => part.type === "text").map((part) => part.text)
			: [],
	);
}

function userTexts(messages: AgentMessage[]): string[] {
	return messages.flatMap((message) =>
		message.role === "user" && typeof message.content === "string" ? [message.content] : [],
	);
}

async function createCursorHarness(contextWindow: number): Promise<Harness> {
	const harness = await createHarness({ provider: "cursor", models: [{ id: "kimi-k3", contextWindow }] });
	harness.agent.sessionId = harness.sessionManager.getSessionId();
	return harness;
}

function installedTransform(harness: Harness): (messages: AgentMessage[]) => Promise<AgentMessage[]> {
	const transform = harness.agent.transformContext;
	if (!transform) throw new Error("expected the Cursor admission transform to be installed");
	return (messages) => transform(messages);
}

describe("1603 cursor history budget", () => {
	const harnesses: Harness[] = [];

	beforeEach(() => {
		resetCursorContextLimitStoreForTest();
	});

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		resetCursorContextLimitStoreForTest();
	});

	it("keeps a 30 KB user turn in a 1M-token window instead of deleting it", async () => {
		// Given: a 1M-token Cursor model and a history whose first turn is 30 KB.
		const harness = await createCursorHarness(1_048_576);
		harnesses.push(harness);
		const messages = [
			userMessage(`${"filler ".repeat(4286)}Remember this codeword: BANANA7.`),
			assistantMessage("OK"),
			userMessage("What codeword did I ask you to remember?"),
		];

		// When: the installed Cursor admission transform runs.
		const admitted = await installedTransform(harness)(messages);

		// Then: every turn survives and the codeword still reaches the provider.
		expect(admitted.length).toBe(messages.length);
		expect(JSON.stringify(admitted)).toContain("BANANA7");
	});

	it("leaves a tool-free 60-turn history untouched inside a 1M-token window", async () => {
		// Given: 60 turns of 10 KB user text and no tool results at all.
		const harness = await createCursorHarness(1_048_576);
		harnesses.push(harness);
		const messages = Array.from({ length: 60 }, (_, index) => [
			userMessage(`turn ${index}: ${"y".repeat(10_000)}`),
			assistantMessage(`reply ${index}`),
		]).flat();

		// When: admission runs against the window-derived budget.
		const admitted = await installedTransform(harness)(messages);
		const admission = admitCursorHistory({ messages, budgetBytes: cursorAdmissionBudgetBytes(1_048_576) });

		// Then: nothing is rewritten and nothing is dropped.
		expect(admitted.length).toBe(messages.length);
		expect(admission.changed).toBe(false);
		expect(admission.blankedToolResults).toBe(0);
		expect(admission.overBudget).toBe(false);
	});

	it("blanks the oldest tool bodies instead of turns when the window is small", async () => {
		// Given: a 8,000-token window (32,000 bytes) and 40 paired tool turns.
		const harness = await createCursorHarness(8_000);
		harnesses.push(harness);
		const messages = pairedToolTurns(40, "z".repeat(3_000));

		// When: the installed transform admits them.
		const admitted = await installedTransform(harness)(messages);
		const admission = admitCursorHistory({ messages, budgetBytes: cursorAdmissionBudgetBytes(8_000) });

		// Then: bodies shrink, conversation structure does not.
		expect(admitted.length).toBe(messages.length);
		expect(userTexts(admitted)).toEqual(userTexts(messages));
		expect(admitted.filter((message) => message.role === "assistant").length).toBe(40);
		const admittedResults = toolResultTexts(admitted);
		expect(admittedResults.length).toBe(40);
		expect(admittedResults.at(-1)).toMatch(/^z+\n\.\.\.\[truncated\]$/);
		expect(Math.max(...admittedResults.map((text) => [...text].length))).toBeLessThanOrEqual(2000);
		expect(admittedResults[0]).toBe("");
		expect(admission.blankedToolResults).toBeGreaterThan(0);
		expect(cursorAdmissionBudgetBytes(8_000)).toBe(32_000);
	});

	it("admits a history that is still over budget after blanking", async () => {
		// Given: a 1,000-token window (4,000 bytes) and 20 KB of pure user text.
		const harness = await createCursorHarness(1_000);
		harnesses.push(harness);
		const messages = [userMessage("w".repeat(20_000)), assistantMessage("OK"), userMessage("and now?")];

		// When: admission runs with nothing blankable.
		const admitted = await installedTransform(harness)(messages);
		const admission = admitCursorHistory({ messages, budgetBytes: cursorAdmissionBudgetBytes(1_000) });

		// Then: the history is handed on untouched for the overflow path to compact.
		expect(admitted.length).toBe(messages.length);
		expect(userTexts(admitted)).toEqual(userTexts(messages));
		expect(admission.messages).toBe(messages);
		expect(admission.changed).toBe(false);
		expect(admission.blankedToolResults).toBe(0);
		expect(admission.overBudget).toBe(true);
	});

	it("sizes context and budget from the ceiling Cursor reported for the model", async () => {
		// Given: a catalog window of 1M and a server-observed ceiling of 200K.
		const harness = await createCursorHarness(1_048_576);
		harnesses.push(harness);
		recordCursorContextLimit("kimi-k3", 200_000);

		// When: a turn is admitted.
		await installedTransform(harness)([userMessage("hi"), assistantMessage("hello"), userMessage("again")]);

		// Then: the live model, its reported usage and the budget all use 200K.
		const model = harness.session.model;
		if (!model) throw new Error("expected a selected model");
		expect(model.contextWindow).toBe(200_000);
		expect(harness.session.getContextUsage()?.contextWindow).toBe(200_000);
		expect(cursorAdmissionBudgetBytes(model.contextWindow)).toBe(800_000);
	});
});
