import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { formatUserMessage, parseAskUserAnswerFrame } from "../../src/core/extensions/builtin/ask-user/format.ts";
import type { ExtensionToolContext, QuestionResponse } from "../../src/core/extensions/types.ts";
import { AskUserAnswerChip } from "../../src/modes/interactive/components/ask-user-answer-chip.ts";
import { loadThemeFromPath, setThemeInstance } from "../../src/modes/interactive/theme/theme.ts";
import { degradeQuestion } from "../../src/modes/rpc/connection-question-bridge.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createAskUserDelivery } from "./helpers/ask-user-delivery.ts";

const QUESTIONS = [
	{ id: "q1", header: "Auth", question: "Which flow?", options: [{ label: "A" }, { label: "B" }], multiSelect: false },
	{ id: "q2", header: "Library", question: "Which?", options: [{ label: "C" }, { label: "D" }], multiSelect: false },
];
beforeEach(() =>
	setThemeInstance(
		loadThemeFromPath(join(import.meta.dirname, "../../src/modes/interactive/theme/dark.json"), "truecolor"),
	),
);
const PARTIAL: QuestionResponse = {
	status: "cancelled",
	cancelOrigin: "user",
	answers: { q1: { selected: ["A"] } },
	unanswered: ["q2"],
};
const NOTHING: QuestionResponse = { status: "cancelled", answers: {}, unanswered: ["q1", "q2"] };

function chipRows(response: QuestionResponse): string[] {
	const message = formatUserMessage(response, "req", QUESTIONS);
	const frame = parseAskUserAnswerFrame(typeof message === "string" ? message : "");
	if (!frame) throw new Error("no answer frame");
	const body = { render: () => [], invalidate() {} };
	return new AskUserAnswerChip(frame, ["Auth", "Library"], body).render(80).map((row) => stripAnsi(row).trimEnd());
}

it("/answer skip after partial answers sends them, and the chip marks the question cancelled", () => {
	expect(formatUserMessage(PARTIAL, "req", QUESTIONS)).toBe(
		"[Answer to question req]\nThe user cancelled the question after answering part of it.\nAuth: A\nUnanswered: Library",
	);
	expect(chipRows(PARTIAL)).toEqual(["↳ (cancelled)", "↳ Auth: A", "↳ Library: (no answer)"]);
});

it("/answer skip with nothing answered still sends the dismissal", () => {
	expect(formatUserMessage(NOTHING, "req", QUESTIONS)).toBe(
		"[Answer to question req]\nThe user dismissed the question.",
	);
	expect(chipRows(NOTHING)).toEqual(["↳ Auth: (no answer)", "↳ Library: (no answer)"]);
});

/** The user cancels (the desktop's Remove) after `progress`, or with `fail` the question UI fails instead. */
async function asyncCancel(progress: QuestionResponse["answers"] | undefined, fail = false, wait = false) {
	const delivery = await createAskUserDelivery();
	const answer = Promise.withResolvers<QuestionResponse>();
	const ctx = delivery.context((_request, opts) => {
		if (progress) opts?.onProgress?.({ answers: progress });
		return answer.promise;
	});
	const params = { questions: QUESTIONS.map(({ id: _id, ...q }) => q), waitForAnswer: wait };
	const execution = delivery.tool.execute("async-q", params, undefined, undefined, ctx as ExtensionToolContext);
	if (!wait) await execution;
	const settled = wait ? undefined : delivery.settled(ctx, "async-q");
	if (fail) answer.reject(new Error("boom"));
	else
		answer.resolve({
			status: "cancelled",
			cancelOrigin: "user",
			answers: progress ?? {},
			unanswered: progress ? ["q2"] : ["q1", "q2"],
		});
	const result = await execution;
	await settled;
	return { deliveries: delivery.deliveries, result };
}

it("an async question cancelled after partial answers delivers one message with them", async () => {
	const { deliveries } = await asyncCancel({ q1: { selected: ["A"] } });
	expect(deliveries).toHaveLength(1);
	expect(deliveries[0]?.content).toBe(
		"[Answer to question async-q]\nThe user cancelled the question after answering part of it.\nAuth: A\nUnanswered: Library",
	);
});

it("an async question cancelled with nothing answered stays silent", async () => {
	const { deliveries } = await asyncCancel(undefined);
	expect(deliveries).toHaveLength(0);
});

it("a blocking question whose UI failed shows the reason and the partial answers", async () => {
	const { result } = await asyncCancel({ q1: { selected: ["A"] } }, true, true);
	expect(result.content.map((part) => ("text" in part ? part.text : "")).join("")).toBe(
		"Question UI failed: boom\nThe question was cancelled after part of it was answered.\nAuth: A\nUnanswered: Library",
	);
});

it("drops a label the fallback select returns after the abort", async () => {
	const controller = new AbortController();
	const select = vi.fn().mockImplementationOnce(async () => {
		controller.abort();
		return "A";
	});
	const request = { requestId: "r", waitForAnswer: true, timeoutMs: 1000, questions: QUESTIONS };
	const response = await degradeQuestion({ select, input: vi.fn() }, request, { signal: controller.signal });
	expect(response).toStrictEqual({ status: "cancelled", answers: {}, unanswered: ["q1", "q2"] });
});
