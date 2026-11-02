/**
 * senpi#2920 round 1: a blocking answer's own words are part of the persisted tool result, so
 * no queue operation can lose them, every request and every resumed session rebuilds them right
 * after the batch's tool results, and each word is announced by its own label block naming the
 * question it answers.
 */

import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { clearOldToolResults } from "../../../src/core/extensions/builtin/compaction/context-reduction.ts";
import type { ExtensionAPI, QuestionResponse } from "../../../src/core/extensions/types.ts";
import { convertToLlm } from "../../../src/core/messages.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { Harness } from "../harness.ts";
import {
	ANSWER,
	afterLastToolResult,
	answerWordBlocks,
	askCall,
	askUserHarness,
	assistantCalls,
	CALL_ID,
	COMMENT,
	commentLabel,
	expectReferencesResolve,
	type QuestionBridge,
	STEER,
	textsOf,
} from "../helpers/ask-user-words-fixture.ts";
import { WIRE_TARGETS, type WireTarget, wireItemsFor } from "../helpers/provider-wire-items.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function target(name: string): WireTarget {
	const found = WIRE_TARGETS.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`no wire target ${name}`);
	return found;
}
const anthropic = target("anthropic-messages");
const chat = target("openai-completions");
const mistral = target("mistral-conversations");

/** Runs one blocking question; `onAnswered` runs once the answer's tool result is persisted. */
async function blockingRun(
	question: QuestionBridge,
	options: {
		persistSession?: boolean;
		onAnswered?: (harness: Harness) => void;
		calls?: ReturnType<typeof askCall>[];
	} = {},
): Promise<{ harness: Harness; next: Context | undefined }> {
	const harness = await askUserHarness(harnesses, question, { persistSession: options.persistSession });
	let next: Context | undefined;
	harness.setResponses([
		assistantCalls(...(options.calls ?? [askCall(true)])),
		(context) => {
			next = context as Context;
			return fauxAssistantMessage("Thanks");
		},
	]);
	const unsubscribe = harness.session.subscribe((event) => {
		if (event.type !== "message_end" || event.message.role !== "toolResult") return;
		if (event.message.toolName !== "ask_user_question") return;
		unsubscribe();
		options.onAnswered?.(harness);
	});
	await harness.session.prompt("Set up auth");
	return { harness, next };
}

function resumedContext(harness: Harness): Context {
	const file = harness.sessionManager.getSessionFile();
	if (!file) throw new Error("the session was not persisted");
	const messages = convertToLlm(SessionManager.open(file).buildSessionContext().messages);
	return { systemPrompt: "You are a test assistant.", messages };
}

async function wordsAfterResults(wire: WireTarget, context: Context): Promise<string[]> {
	const { items } = await wireItemsFor(wire, context);
	return textsOf(afterLastToolResult(items).following);
}

describe("senpi#2920 an answer's words survive every queue operation", () => {
	it("an abort before the next request keeps the words for the resumed session", async () => {
		const { harness } = await blockingRun(async () => ANSWER, {
			persistSession: true,
			onAnswered: (session) => void session.session.abort(),
		});
		expect((await wordsAfterResults(anthropic, resumedContext(harness))).slice(0, 4)).toEqual(answerWordBlocks());
	});

	it("clearing the queue after the answer still sends the words", async () => {
		const { next } = await blockingRun(async () => ANSWER, {
			onAnswered: (session) => void session.session.clearQueue(),
		});
		if (!next) throw new Error("no request followed the answer");
		expect((await wordsAfterResults(anthropic, next)).slice(0, 4)).toEqual(answerWordBlocks());
	});

	it.each([anthropic, chat])("$name: a session resumed from disk sends the same wire shape", async (wire) => {
		const { harness, next } = await blockingRun(async () => ANSWER, { persistSession: true });
		if (!next) throw new Error("no request followed the answer");
		const live = (await wireItemsFor(wire, next)).items;
		const resumed = (await wireItemsFor(wire, resumedContext(harness))).items;
		expect(resumed.slice(0, live.length)).toEqual(live);
	});

	it("openai-completions: the words follow every tool message of a multi-tool batch", async () => {
		const probe = fauxToolCall("probe_2920", {}, { id: "toolu_probe_2920" });
		const { next } = await blockingRun(async () => ANSWER, { calls: [askCall(true), probe] });
		if (!next) throw new Error("no request followed the answer");
		const { items } = await wireItemsFor(chat, next);
		const tools = items.flatMap((item, index) => (item.kind === "toolResult" ? [index] : []));
		const firstWord = items.findIndex((item) => item.kind === "userText" && item.text === commentLabel(CALL_ID));
		expect(tools).toHaveLength(2);
		expect(firstWord).toBeGreaterThan(Math.max(...tools));
	});
});

describe("senpi#2920 the word message next to other user turns", () => {
	it("mistral-conversations: the words and the next prompt share one user message", async () => {
		const { next } = await blockingRun(async () => ANSWER);
		if (!next) throw new Error("no request followed the answer");
		const prompt = {
			role: "user" as const,
			content: [{ type: "text" as const, text: STEER }],
			timestamp: Date.now(),
		};
		const { items } = await wireItemsFor(mistral, { ...next, messages: [...next.messages, prompt] });
		const { result, following } = afterLastToolResult(items);
		expect(textsOf(following)).toEqual([...answerWordBlocks(), STEER]);
		expect(new Set(following.map((item) => item.message)).size).toBe(1);
		expect(following[0]?.message).toBe(result.message + 1);
	});

	it("clearing an old ask-user result keeps its words for the model", async () => {
		const { next, harness } = await blockingRun(async () => ANSWER);
		if (!next) throw new Error("no request followed the answer");
		const cleared = clearOldToolResults(harness.session.messages, {
			clearableToolNames: ["ask_user_question"],
			keepRecent: 0,
		});
		expect(cleared.toolResultsCleared).toBe(1);
		const words = await wordsAfterResults(anthropic, { ...next, messages: convertToLlm(cleared.messages) });
		expect(words.slice(0, 4)).toEqual(answerWordBlocks());
	});
});

describe("senpi#2920 converting twice adds the words once", () => {
	it("convertToLlm over its own output keeps one word message after the tool results", async () => {
		const { next } = await blockingRun(async () => ANSWER);
		if (!next) throw new Error("no request followed the answer");
		const twice = convertToLlm(convertToLlm(next.messages));
		const words = await wordsAfterResults(anthropic, { ...next, messages: twice });
		expect(words.filter((text) => text === COMMENT)).toHaveLength(1);
		expect(words.slice(0, 4)).toEqual(answerWordBlocks());
	});
});

describe("senpi#2920 every word is labelled with the question it answers", () => {
	it("two blocking questions in one batch reference their own labels", async () => {
		const answer = (comment: string): QuestionResponse => ({
			status: "comment-submitted",
			comment,
			answers: {},
			unanswered: ["q1", "q2"],
		});
		const { next } = await blockingRun(async (request) => answer(`comment for ${request.requestId}`), {
			calls: [askCall(true, "toolu_first"), askCall(true, "toolu_second")],
		});
		if (!next) throw new Error("no request followed the answers");
		const { items } = await wireItemsFor(anthropic, next);
		const results = items.filter((item) => item.kind === "toolResult");
		const words = afterLastToolResult(items).following;
		expect(textsOf(words).slice(0, 4)).toEqual([
			commentLabel("toolu_first"),
			"comment for toolu_first",
			commentLabel("toolu_second"),
			"comment for toolu_second",
		]);
		for (const result of results) {
			if (result.kind !== "toolResult") continue;
			expectReferencesResolve(result.text, words);
		}
		expect(results[0]?.kind === "toolResult" && results[0].text).toContain(commentLabel("toolu_first"));
		expect(results[1]?.kind === "toolResult" && results[1].text).toContain(commentLabel("toolu_second"));
	});

	it("a steer typed while the question was open comes after the answer's words", async () => {
		const { next } = await blockingRun(async () => {
			await harnesses.at(-1)?.session.steer(STEER);
			return ANSWER;
		});
		if (!next) throw new Error("no request followed the answer");
		expect((await wordsAfterResults(anthropic, next)).slice(0, 5)).toEqual([...answerWordBlocks(), STEER]);
	});
});

describe("senpi#2920 an input rewrite keeps a later answer's blocks apart", () => {
	it("an input handler that rewrites a mention leaves the frame and the words in their own blocks", async () => {
		const mention = "see @mcp:docs/plan please";
		const rewriter = (pi: ExtensionAPI) => {
			pi.on("input", async (event) =>
				event.text.includes("@mcp:")
					? { action: "transform", text: event.text.replace("@mcp:docs/plan", "PLAN DOC") }
					: undefined,
			);
		};
		const answer = Promise.withResolvers<QuestionResponse>();
		const harness = await askUserHarness(harnesses, () => answer.promise, { extensions: [rewriter] });
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
		answer.resolve({ status: "comment-submitted", comment: mention, answers: {}, unanswered: ["q1", "q2"] });
		await answered;
		if (!next) throw new Error("the answer started no request");
		const { items } = await wireItemsFor(anthropic, next);
		const frame = items.findIndex(
			(item) => item.kind === "userText" && item.text.startsWith(`[Answer to question ${CALL_ID}]`),
		);
		expect(frame).toBeGreaterThan(-1);
		expect(textsOf(items.slice(frame + 1, frame + 3))).toEqual([commentLabel(CALL_ID), mention]);
		expect(textsOf(items.slice(frame, frame + 1))[0]).not.toContain(COMMENT);
		const forkable = harness.session.getUserMessagesForForking().map((message) => message.text);
		expect(forkable).toContain(
			`[Answer to question ${CALL_ID}]\nThe user responded: ${mention}\nUnanswered: Auth, Plan`,
		);
	});
});
