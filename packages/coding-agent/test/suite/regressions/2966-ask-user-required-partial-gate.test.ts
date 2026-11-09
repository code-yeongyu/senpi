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
});
