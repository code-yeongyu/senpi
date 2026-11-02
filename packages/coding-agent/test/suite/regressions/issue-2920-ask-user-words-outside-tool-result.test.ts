/**
 * senpi#2920: the words a user types into an ask-user answer (a free-text comment or a typed
 * option) never ride inside a tool_result. Claude Haiku 5.5 is trained to treat tool results as
 * untrusted, so "Mid-turn user messages" in Anthropic's prompting guide asks for them as a user
 * text block after the last tool_result, with no harness notice in the same block.
 *
 * The real ask-user builtin runs a real turn on the faux provider; the request that follows the
 * answer is then serialized by every first-party adapter that maps tool results.
 */

import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Text } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import {
	askUserAnswerDisplayText,
	formatResultText,
	formatUserMessage,
} from "../../../src/core/extensions/builtin/ask-user/format.ts";
import type { QuestionResponse } from "../../../src/core/extensions/types.ts";
import type { Harness } from "../harness.ts";
import {
	ANSWER,
	afterLastToolResult,
	answerWordBlocks,
	askCall,
	askUserHarness,
	assistantCalls,
	CALL_ID,
	CANONICAL,
	COMMENT,
	expectReferencesResolve,
	STEER,
	TYPED,
	textsOf,
} from "../helpers/ask-user-words-fixture.ts";
import { WIRE_TARGETS, wireItemsFor } from "../helpers/provider-wire-items.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function syncAnswerRun(): Promise<{ harness: Harness; next: Context }> {
	const harness = await askUserHarness(harnesses, async () => ANSWER);
	let next: Context | undefined;
	harness.setResponses([
		assistantCalls(askCall(true)),
		(context) => {
			next = context as Context;
			return fauxAssistantMessage("Thanks");
		},
	]);
	await harness.session.prompt("Set up auth");
	if (!next) throw new Error("no request followed the answer");
	return { harness, next };
}

async function asyncAnswerContext(): Promise<Context> {
	const answer = Promise.withResolvers<QuestionResponse>();
	const harness = await askUserHarness(harnesses, () => answer.promise);
	let next: Context | undefined;
	harness.setResponses([
		assistantCalls(askCall(false)),
		fauxAssistantMessage("I will keep going while you decide."),
		(context) => {
			next = context as Context;
			return fauxAssistantMessage("Thanks");
		},
	]);
	await harness.session.prompt("Set up auth");
	const answered = new Promise<void>((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== "agent_end" || !next) return;
			unsubscribe();
			resolve();
		});
	});
	answer.resolve(ANSWER);
	await answered;
	if (!next) throw new Error("the answer started no request");
	return next;
}

/** The shape the steering queue produces: a typed user message after a tool result. */
function steeredContext(): Context {
	const call = fauxAssistantMessage([fauxToolCall("bash", { command: "make" }, { id: CALL_ID })], {
		stopReason: "toolUse",
	});
	return {
		systemPrompt: "You are a test assistant.",
		messages: [
			{ role: "user", content: "Run the build", timestamp: 1 },
			call,
			{
				role: "toolResult",
				toolCallId: CALL_ID,
				toolName: "bash",
				content: [{ type: "text", text: "build ok" }],
				isError: false,
				timestamp: 3,
			},
			{ role: "user", content: [{ type: "text", text: STEER }], timestamp: 4 },
		],
	};
}

const occurrences = (body: string, text: string) => body.split(text).length - 1;

describe("senpi#2920 ask-user answers keep the user's words out of tool_result", () => {
	let sync: ReturnType<typeof syncAnswerRun> | undefined;
	let later: Promise<Context> | undefined;

	it.each(WIRE_TARGETS)("$name: a blocking answer puts the user's words after the tool result", async (target) => {
		sync ??= syncAnswerRun();
		const { items, body } = await wireItemsFor(target, (await sync).next);
		const { result, following } = afterLastToolResult(items);
		expect(result.text).toContain("OAuth");
		expect(result.text).not.toContain(COMMENT);
		expect(result.text).not.toContain(TYPED);
		const words = following.slice(0, 4);
		expect(textsOf(words)).toEqual(answerWordBlocks());
		expectReferencesResolve(result.text, words);
		for (const item of words) {
			if (target.sameMessage) expect(item.message).toBe(result.message);
			else expect(item.message).toBeGreaterThan(result.message);
		}
		expect([occurrences(body, COMMENT), occurrences(body, TYPED)]).toEqual([1, 1]);
	});

	it.each(WIRE_TARGETS)(
		"$name: a later answer keeps its label and the user's words in separate blocks",
		async (target) => {
			later ??= asyncAnswerContext();
			const { items, body } = await wireItemsFor(target, await later);
			const label = items.findIndex(
				(item) => item.kind === "userText" && item.text.startsWith(`[Answer to question ${CALL_ID}]`),
			);
			const labelItem = items[label];
			if (labelItem?.kind !== "userText") throw new Error("no answer frame on the wire");
			expect(labelItem.text).not.toContain(COMMENT);
			expect(labelItem.text).not.toContain(TYPED);
			const words = items.slice(label + 1, label + 5);
			expect(textsOf(words)).toEqual(answerWordBlocks());
			expectReferencesResolve(labelItem.text, words);
			expect(words.every((item) => item.message === labelItem.message)).toBe(true);
			expect([occurrences(body, COMMENT), occurrences(body, TYPED)]).toEqual([1, 1]);
		},
	);

	it.each(WIRE_TARGETS)("$name: a steered message stays a user text after the tool result", async (target) => {
		const { items } = await wireItemsFor(target, steeredContext());
		const { result, following } = afterLastToolResult(items);
		expect(result.text).not.toContain(STEER);
		const first = following.find((item) => item.kind !== "other");
		expect(first).toMatchObject({ kind: "userText", text: STEER });
		if (target.sameMessage) expect(first?.message).toBe(result.message);
	});

	it("the transcript still shows the words where the user gave them", async () => {
		sync ??= syncAnswerRun();
		const { harness } = await sync;
		const tool = harness.session.getToolDefinition("ask_user_question");
		const result = harness.session.messages.findLast((message) => message.role === "toolResult");
		if (!tool?.renderResult || result?.role !== "toolResult") throw new Error("no ask-user result");
		const rendered = tool.renderResult(
			{ content: result.content, details: result.details },
			{ expanded: true, isPartial: false },
			{} as never,
			{} as never,
		);
		expect(rendered).toBeInstanceOf(Text);
		const inline = formatResultText("claude", ANSWER, CANONICAL);
		const lines = (rendered as Text).render(400).map((line) => line.trimEnd());
		expect(lines.slice(1)).toEqual(inline.split("\n"));
		const frame = formatUserMessage(ANSWER, CALL_ID, CANONICAL);
		if (typeof frame === "string") throw new Error("typed words must leave the frame block");
		expect(askUserAnswerDisplayText(frame)).toBe(`[Answer to question ${CALL_ID}]\n${inline}`);
	});
});
