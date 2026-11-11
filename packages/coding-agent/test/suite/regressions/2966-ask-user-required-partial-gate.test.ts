import { describe, expect, it } from "vitest";
import {
	formatModelAnswer,
	formatResultText,
	formatUserMessage,
} from "../../../src/core/extensions/builtin/ask-user/format.ts";
import type { QuestionRequest, QuestionResponse } from "../../../src/core/extensions/builtin/ask-user/schema.ts";

const QUESTIONS: QuestionRequest["questions"] = [
	{
		id: "q1",
		header: "Approve",
		question: "Write the plan now?",
		options: [{ label: "Yes" }, { label: "No" }],
		multiSelect: false,
	},
	{
		id: "q2",
		header: "Deploy",
		question: "Deploy it now?",
		options: [{ label: "Yes" }, { label: "No" }],
		multiSelect: false,
	},
];

// senpi#2966 gap 1: a required call that settles as "answered" with some
// questions still unanswered must refuse the gated action, not read as an
// ordinary partial answer.
const partialAnswered: QuestionResponse = {
	status: "answered",
	answers: { q2: { selected: ["Yes"] } },
	unanswered: ["q1"],
};
const partialComment: QuestionResponse = {
	status: "comment-submitted",
	comment: "go ahead with the second one",
	answers: { q2: { selected: ["Yes"] } },
	unanswered: ["q1"],
};
const fullyAnswered: QuestionResponse = {
	status: "answered",
	answers: { q1: { selected: ["Yes"] }, q2: { selected: ["No"] } },
	unanswered: [],
};
// Maintainer follow-up on #6283: a comment-only reply settles as "comment-submitted" with
// every question in `unanswered`, so it always hits the required gate.
const commentOnly: QuestionResponse = {
	status: "comment-submitted",
	comment: "hold on, checking with the team",
	answers: {},
	unanswered: ["q1"],
};

function renderings(response: QuestionResponse, required: boolean): string[] {
	const text = formatResultText("claude", response, QUESTIONS, required);
	const modelText = formatModelAnswer(response, "req-1", QUESTIONS, required).text;
	const frame = formatUserMessage(response, "req-1", QUESTIONS, required);
	const frameText = typeof frame === "string" ? frame : frame.map((block) => block.text).join("\n");
	return [text, modelText, frameText];
}

describe("senpi#2966 a required question answered only in part", () => {
	it.each([
		["answered", partialAnswered],
		["comment-submitted", partialComment],
	] as const)(
		"refuses the gated action when a required call settles %s with unanswered questions",
		(_label, response) => {
			// given a required multi-question call with one question unanswered
			// when the tool result and the late-answer frame are rendered
			// then every rendering refuses the gated action, names the unanswered question, and never invites best judgment
			for (const rendered of renderings(response, true)) {
				expect(rendered).toContain("do not take the action it gates");
				expect(rendered).toContain("Approve");
				expect(rendered).not.toMatch(/best judgment/i);
				expect(rendered).not.toMatch(/continue the work/i);
			}
		},
	);

	it("leaves a fully answered required call unchanged", () => {
		// given a required call with every question answered
		// then the rendering shows the answers and refuses nothing
		for (const rendered of renderings(fullyAnswered, true)) {
			expect(rendered).toContain("Approve: Yes");
			expect(rendered).toContain("Deploy: No");
			expect(rendered).not.toContain("do not take the action it gates");
		}
	});

	it("keeps today's exact text for a partial answer that is not required", () => {
		// given the same partial settlement on an ordinary question
		// then the rendering is exactly what main produces today
		expect(formatResultText("claude", partialAnswered, QUESTIONS, false)).toBe("Deploy: Yes\nUnanswered: Approve");
		expect(formatResultText("claude", partialComment, QUESTIONS, false)).toBe(
			"The user responded: go ahead with the second one\nDeploy: Yes\nUnanswered: Approve",
		);
	});

	it("keeps a comment-only reply to a required question gated without dropping the comment", () => {
		// given a required single-question call answered with a comment only
		// when the tool result and the late-answer frame are rendered
		// then the action stays gated, the reason says the question went unanswered instead of
		// claiming a partial answer, and the comment survives: inline in the result text, as a
		// labelled word block in the frame, and in `words` (the model text names it by label)
		for (const rendered of renderings(commentOnly, true)) {
			expect(rendered).toContain("The user left a comment without answering the question.");
			expect(rendered).toContain("do not take the action it gates");
			expect(rendered).not.toContain("The user answered only part of the question.");
			expect(rendered).not.toContain("No answer:");
			expect(rendered).not.toMatch(/best judgment/i);
		}
		expect(formatResultText("claude", commentOnly, QUESTIONS, true)).toContain("hold on, checking with the team");
		expect(renderings(commentOnly, true)[2]).toContain("hold on, checking with the team");
		const words = formatModelAnswer(commentOnly, "req-1", QUESTIONS, true).words;
		expect(words.map((word) => word.text)).toContain("hold on, checking with the team");
	});

	it("keeps the comment on a multi-question partial answer to a required call", () => {
		// given a required multi-question call answered in part with a comment attached
		// when the tool result and the late-answer frame are rendered
		// then the comment survives in the same three places, the partial reason stands, and
		// the closing line is partial-specific instead of the shared "No answer:" line
		for (const rendered of renderings(partialComment, true)) {
			expect(rendered).toContain("The user answered only part of the question.");
			expect(rendered).toContain("until it is answered");
			expect(rendered).not.toContain("No answer:");
		}
		expect(formatResultText("claude", partialComment, QUESTIONS, true)).toContain("go ahead with the second one");
		expect(renderings(partialComment, true)[2]).toContain("go ahead with the second one");
		const words = formatModelAnswer(partialComment, "req-1", QUESTIONS, true).words;
		expect(words.map((word) => word.text)).toContain("go ahead with the second one");
	});

	it("ends a partial gated rendering with a partial-specific line, not 'No answer:'", () => {
		// given a required multi-question call answered in part with no comment
		// then the closing line names the still-gating unanswered question instead of
		// contradicting the answers above it with "No answer:"
		for (const rendered of renderings(partialAnswered, true)) {
			expect(rendered).toContain("until it is answered");
			expect(rendered).not.toContain("No answer:");
		}
	});
});
