/**
 * Shared fixture for the senpi#2920 ask-user word-placement regressions: the real ask-user
 * builtin on a faux-provider session, a question bridge the test scripts, and the labelled
 * word blocks every answer must produce after its tool result or answer frame.
 */

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect } from "vitest";
import askUserExtension from "../../../src/core/extensions/builtin/ask-user/index.ts";
import type { ExtensionAPI, QuestionRequest, QuestionResponse } from "../../../src/core/extensions/types.ts";
import { createHarness, createTestUiContext, type Harness, type HarnessOptions } from "../harness.ts";
import type { WireItem } from "./provider-wire-items.ts";

export const CALL_ID = "toolu_ask_2920";
export const COMMENT = "Please keep the migration reversible";
export const TYPED = "ship it behind a feature flag first";
export const STEER = "also update the changelog";
export const QUESTIONS = [
	{
		header: "Auth",
		question: "Which auth flow?",
		multiSelect: false,
		options: [{ label: "OAuth" }, { label: "API key" }],
	},
	{
		header: "Plan",
		question: "Which rollout?",
		multiSelect: false,
		options: [{ label: "Canary" }, { label: "Big bang" }],
	},
];
export const CANONICAL = QUESTIONS.map((question, index) => ({ ...question, id: `q${index + 1}` }));
// OAuth was offered by the model; the comment and the typed rollout plan are the user's own words.
export const ANSWER: QuestionResponse = {
	status: "comment-submitted",
	comment: COMMENT,
	answers: { q1: { selected: ["OAuth"] }, q2: { selected: [], text: TYPED } },
	unanswered: [],
};

export type QuestionBridge = (request: QuestionRequest) => Promise<QuestionResponse>;

export async function askUserHarness(
	harnesses: Harness[],
	question: QuestionBridge,
	options: Pick<HarnessOptions, "persistSession"> & { extensions?: Array<(pi: ExtensionAPI) => void> } = {},
): Promise<Harness> {
	const harness = await createHarness({
		extensionFactories: [
			{ factory: askUserExtension },
			...(options.extensions ?? []).map((factory) => ({ factory })),
		],
		settings: { askUser: { enabled: true } },
		persistSession: options.persistSession,
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({ uiContext: createTestUiContext({ question }), mode: "tui" });
	return harness;
}

export function askCall(waitForAnswer: boolean, id = CALL_ID) {
	return fauxToolCall("ask_user_question", { questions: QUESTIONS, waitForAnswer }, { id });
}

export function assistantCalls(...calls: ReturnType<typeof fauxToolCall>[]) {
	return fauxAssistantMessage(calls, { stopReason: "toolUse" });
}

export function commentLabel(id: string): string {
	return `[The user's comment for question ${id}]`;
}

export function typedLabel(header: string, id: string): string {
	return `[The user's answer to ${header} for question ${id}]`;
}

/** The four blocks ANSWER produces for question `id`: each of the user's words after its own label. */
export function answerWordBlocks(id = CALL_ID): string[] {
	return [commentLabel(id), COMMENT, typedLabel("Plan", id), TYPED];
}

export const textsOf = (items: WireItem[]) => items.map((item) => (item.kind === "userText" ? item.text : item.kind));

export function afterLastToolResult(items: WireItem[]): {
	result: WireItem & { kind: "toolResult" };
	following: WireItem[];
} {
	const index = items.findLastIndex((item) => item.kind === "toolResult");
	const result = items[index];
	if (result?.kind !== "toolResult") throw new Error("no tool result on the wire");
	return { result, following: items.slice(index + 1) };
}

/** Every reference a tool result or frame makes names a label block that is on the wire. */
export function expectReferencesResolve(text: string, items: WireItem[]): void {
	const references = [...text.matchAll(/\(see (\[[^\]]+\]) below\)/g)].map((match) => match[1]);
	expect(references.length).toBeGreaterThan(0);
	const labels = textsOf(items);
	for (const reference of references) expect(labels).toContain(reference);
}
