import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxOverflowError } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { estimateTokens } from "../../../src/core/compaction/compaction.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * #4032: the core summarizer (used by overflow recovery and by pre-prompt admission compaction) summarized every
 * message it compacts in ONE request, unbounded. When that history is close to the window, the summary request
 * overflowed the same window, so the compaction (and with it overflow recovery) could never succeed.
 */
const CONTEXT_WINDOW = 20_000;
const MAX_TOKENS = 4_000;
const TURN_TEXT = "long-running session history ".repeat(100);

/** The provider's own size check: about four characters per token over everything it is sent. */
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

function omittedHistoryCount(context: TranscriptContext): number | undefined {
	const last = context.messages.at(-1);
	if (last?.role !== "user") return undefined;
	const text =
		typeof last.content === "string"
			? last.content
			: last.content.map((block) => ("text" in block ? block.text : "")).join("");
	const match = /<omitted-history messages="(\d+)" \/>/.exec(text);
	return match === null ? undefined : Number(match[1]);
}

function isSummaryRequest(context: TranscriptContext): boolean {
	const last = context.messages.at(-1);
	if (last?.role !== "user") return false;
	const text =
		typeof last.content === "string"
			? last.content
			: last.content.map((block) => ("text" in block ? block.text : "")).join("");
	return text.includes("<conversation>");
}

function seedHistoryJustUnderTheWindow(harness: Harness): number {
	const model = harness.getModel();
	let timestamp = 1;
	for (let turn = 0; turn < 25; turn++) {
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `${TURN_TEXT} question ${turn}` }],
			timestamp: timestamp++,
		});
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage(`answer ${turn}`, { timestamp: timestamp++ }),
			api: model.api,
			provider: model.provider,
			model: model.id,
		});
	}
	const messages = harness.sessionManager.buildSessionContext().messages;
	harness.session.agent.state.messages = messages;
	return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

describe("#4032 compaction when the summarizer input itself would overflow the window", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("#given a history just under the window #when the next turn needs a compaction #then every summary request fits the window and the turn completes", async () => {
		// given: a provider that rejects only requests whose input plus output budget exceeds its window
		const harness = await createHarness({
			models: [{ id: "small-window", contextWindow: CONTEXT_WINDOW, maxTokens: MAX_TOKENS }],
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		const seeded = seedHistoryJustUnderTheWindow(harness);
		expect(seeded).toBeLessThan(CONTEXT_WINDOW);
		expect(seeded + MAX_TOKENS).toBeGreaterThan(CONTEXT_WINDOW);
		const summaryRequests: number[] = [];
		const acceptedSummaryOmissions: Array<number | undefined> = [];
		harness.faux.setResponses(
			Array.from({ length: 12 }, () => (context: TranscriptContext, options: { maxTokens?: number } | undefined) => {
				const requested = providerInputTokens(context) + (options?.maxTokens ?? MAX_TOKENS);
				const summary = isSummaryRequest(context);
				if (summary) summaryRequests.push(requested);
				if (requested > CONTEXT_WINDOW) {
					return fauxOverflowError("faux", "Your input exceeds the context window of this model.");
				}
				if (summary) acceptedSummaryOmissions.push(omittedHistoryCount(context));
				return fauxAssistantMessage(summary ? "summary of the long session" : "continued after compaction");
			}),
		);

		// when
		await harness.session.prompt("one more question");

		// then
		expect(summaryRequests.length).toBeGreaterThan(0);
		expect(summaryRequests.every((requested) => requested <= CONTEXT_WINDOW)).toBe(true);
		expect(acceptedSummaryOmissions.length).toBeGreaterThan(0);
		expect(acceptedSummaryOmissions.every((omitted) => omitted !== undefined && omitted > 0)).toBe(true);
		expect(harness.eventsOfType("compaction_end").some((event) => event.result !== undefined)).toBe(true);
		const lastAssistant = [...harness.session.messages].reverse().find((message) => message.role === "assistant");
		expect(lastAssistant).toMatchObject({ stopReason: "stop" });
	});
});
