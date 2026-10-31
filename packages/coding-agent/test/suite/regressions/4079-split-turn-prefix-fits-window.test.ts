import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxOverflowError, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { estimateTokens } from "../../../src/core/compaction/compaction.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * #4079 item 3: when the compaction cut lands inside one long turn, the turn's prefix is summarized in its own
 * request. That request was unbounded, so a single turn close to the window made the compaction (and overflow
 * recovery with it) fail exactly as #4032 did for the history summary.
 */
const CONTEXT_WINDOW = 20_000;
const MAX_TOKENS = 4_000;
const STEP_TEXT = "working through the long task step by step ".repeat(40);

function providerInputTokens(context: TranscriptContext): number {
	let chars = 0;
	for (const message of context.messages) {
		if (typeof message.content === "string") {
			chars += message.content.length;
			continue;
		}
		for (const block of message.content) {
			if (block.type === "text") chars += block.text.length;
			else if (block.type === "thinking") chars += block.thinking.length;
			else chars += JSON.stringify(block).length;
		}
	}
	return Math.ceil(chars / 4);
}

function lastUserText(context: TranscriptContext): string {
	const last = context.messages.at(-1);
	if (last?.role !== "user") return "";
	return typeof last.content === "string"
		? last.content
		: last.content.map((block) => ("text" in block ? block.text : "")).join("");
}

function isTurnPrefixSummaryRequest(context: TranscriptContext): boolean {
	return lastUserText(context).startsWith("# Conversation\n");
}

function isSummaryRequest(context: TranscriptContext): boolean {
	const text = lastUserText(context);
	return text.includes("<conversation>") || text.startsWith("# Conversation\n");
}

function seedOneLongTurn(harness: Harness): number {
	const model = harness.getModel();
	let timestamp = 1;
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "refactor the whole module" }],
		timestamp: timestamp++,
	});
	for (let step = 0; step < 40; step++) {
		const call = fauxToolCall("read", { path: `src/file-${step}.ts` }, { id: `call-${step}` });
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage([fauxText(`${STEP_TEXT} ${step}`), call], {
				stopReason: "toolUse",
				timestamp: timestamp++,
			}),
			api: model.api,
			provider: model.provider,
			model: model.id,
		});
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: call.id,
			toolName: "read",
			content: [{ type: "text", text: `contents of file ${step}` }],
			isError: false,
			timestamp: timestamp++,
		});
	}
	const messages = harness.sessionManager.buildSessionContext().messages;
	harness.session.agent.state.messages = messages;
	return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

describe("#4079 a split-turn prefix summary fits the window", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("#given one turn just under the window #when the next prompt needs a compaction that cuts inside that turn #then every summary request fits the window and the prompt completes", async () => {
		// given: a provider that rejects only requests whose input plus output budget exceeds its window
		const harness = await createHarness({
			models: [{ id: "small-window", contextWindow: CONTEXT_WINDOW, maxTokens: MAX_TOKENS }],
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		const seeded = seedOneLongTurn(harness);
		expect(seeded).toBeLessThan(CONTEXT_WINDOW);
		expect(seeded + MAX_TOKENS).toBeGreaterThan(CONTEXT_WINDOW);
		const summaryRequests: number[] = [];
		let turnPrefixRequests = 0;
		const acceptedTurnPrefixRequests: string[] = [];
		harness.faux.setResponses(
			Array.from({ length: 12 }, () => (context: TranscriptContext, options: { maxTokens?: number } | undefined) => {
				const requested = providerInputTokens(context) + (options?.maxTokens ?? MAX_TOKENS);
				const summary = isSummaryRequest(context);
				if (summary) summaryRequests.push(requested);
				if (isTurnPrefixSummaryRequest(context)) turnPrefixRequests += 1;
				if (requested > CONTEXT_WINDOW) {
					return fauxOverflowError("faux", "Your input exceeds the context window of this model.");
				}
				if (isTurnPrefixSummaryRequest(context)) acceptedTurnPrefixRequests.push(lastUserText(context));
				return fauxAssistantMessage(summary ? "summary of the long turn" : "continued after compaction");
			}),
		);

		// when
		await harness.session.prompt("one more question");

		// then
		expect(turnPrefixRequests).toBeGreaterThan(0);
		expect(summaryRequests.every((requested) => requested <= CONTEXT_WINDOW)).toBe(true);
		// the accepted request keeps the turn's own request and says how many tool steps it left out
		expect(acceptedTurnPrefixRequests).toHaveLength(1);
		expect(acceptedTurnPrefixRequests[0]).toContain("refactor the whole module");
		expect(acceptedTurnPrefixRequests[0]).toMatch(/<omitted-history messages="[1-9]\d*" \/>/);
		expect(harness.eventsOfType("compaction_end").some((event) => event.result !== undefined)).toBe(true);
		const lastAssistant = [...harness.session.messages].reverse().find((message) => message.role === "assistant");
		expect(lastAssistant).toMatchObject({ stopReason: "stop" });
	});
});
