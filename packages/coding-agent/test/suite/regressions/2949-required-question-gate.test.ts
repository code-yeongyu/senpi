import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	formatModelAnswer,
	formatResultText,
	formatUserMessage,
} from "../../../src/core/extensions/builtin/ask-user/format.ts";
import {
	AskUserSchemaError,
	type AskUserVariant,
	CLAUDE_PARAMS,
	CODEX_PARAMS,
	type QuestionRequest,
	type QuestionResponse,
	toCanonical,
} from "../../../src/core/extensions/builtin/ask-user/schema.ts";

const QUESTIONS: QuestionRequest["questions"] = [
	{
		id: "q1",
		header: "Approve",
		question: "Write the plan now?",
		options: [{ label: "Yes" }, { label: "No" }],
		multiSelect: false,
	},
];
const VARIANTS: AskUserVariant[] = ["codex", "claude"];
const CODEX_ARGS = {
	questions: [
		{
			id: "approve",
			header: "Approve",
			question: "Write the plan now?",
			options: [
				{ label: "Yes", description: "Write it." },
				{ label: "No", description: "Do not write it." },
			],
		},
	],
	wait_for_answer: true,
};
const CLAUDE_ARGS = {
	questions: [
		{
			header: "Approve",
			question: "Write the plan now?",
			options: [{ label: "Yes" }, { label: "No" }],
			multiSelect: false,
		},
	],
	waitForAnswer: true,
};

const noAnswer: Record<string, QuestionResponse> = {
	timed_out: { status: "timed_out", answers: {}, unanswered: ["q1"], autoResolvedAfterMs: 60_000 },
	timed_out_with_draft: {
		status: "timed_out",
		answers: { q1: { selected: ["Yes"] } },
		unanswered: [],
		autoResolvedAfterMs: 60_000,
	},
	cancelled: { status: "cancelled", answers: {}, unanswered: ["q1"] },
	"orphaned-after-restart": { status: "orphaned-after-restart", answers: {}, unanswered: ["q1"] },
	unavailable: { status: "unavailable", answers: {}, unanswered: ["q1"] },
};

describe("senpi#2949 a question that gates an action", () => {
	it.each(Object.entries(noAnswer))(
		"never tells the model to proceed when a required question ends %s",
		(_label, response) => {
			// given a required question that settled without an answer
			for (const variant of VARIANTS) {
				// when the tool result and the late-answer frame are rendered
				const text = formatResultText(variant, response, QUESTIONS, true);
				const modelText = formatModelAnswer(response, "req-1", QUESTIONS, true).text;
				const frame = formatUserMessage(response, "req-1", QUESTIONS, true);
				const frameText = typeof frame === "string" ? frame : frame.map((block) => block.text).join("\n");

				// then the person-facing text, the model-facing tool result and the frame all refuse, and none invites best judgment
				for (const rendered of [text, modelText, frameText]) {
					expect(rendered).toContain("do not take the action it gates");
					expect(rendered).not.toMatch(/best judgment/i);
					expect(rendered).not.toMatch(/continue the work/i);
				}
			}
		},
	);

	it("reports a selection made before going idle, but not as an answer", () => {
		// given a required question that timed out after the user had picked an option
		const text = formatResultText("claude", noAnswer.timed_out_with_draft, QUESTIONS, true);

		// then the selection is visible and explicitly not an answer
		expect(text).toContain("Approve: Yes");
		expect(text).toContain("not an answer");
		expect(text).toContain("do not take the action it gates");
	});

	it("keeps today's exact text for a question that is not required", () => {
		// given the same settlements on an ordinary question
		const expected: Record<string, string> = {
			timed_out:
				"The user did not answer within 1 minutes. (사용자가 답변을 안하고 timeout 으로 종료됨)\nContinue the work to completion on your best judgment; do not ask this question again this turn.",
			timed_out_with_draft:
				"The user did not answer within 1 minutes. (사용자가 답변을 안하고 timeout 으로 종료됨)\nBefore going idle the user had selected: Approve: Yes\nContinue the work to completion on your best judgment; do not ask this question again this turn.",
			cancelled: "The user dismissed the question.",
			"orphaned-after-restart":
				"The pending question could not be resumed after a restart; continue on best judgment.",
			unavailable: "This session has no user attached (subagent or headless); decide on best judgment.",
		};

		// then each renders exactly as main does
		for (const [label, response] of Object.entries(noAnswer)) {
			expect(formatResultText("codex", response, QUESTIONS, false)).toBe(expected[label]);
		}
	});

	it("keeps the owner's timeout marker on a required question", () => {
		// given a required question that timed out
		const text = formatResultText("claude", noAnswer.timed_out, QUESTIONS, true);

		// then the Korean idle-timeout marker is still there
		expect(text).toContain("(사용자가 답변을 안하고 timeout 으로 종료됨)");
	});

	it("accepts an optional required flag in both tool variants and carries it on the request", () => {
		// given calls that mark the question as required
		const codex = toCanonical("codex", { ...CODEX_ARGS, required: true });
		const claude = toCanonical("claude", { ...CLAUDE_ARGS, required: true });

		// then the schemas accept it and the canonical request carries it
		expect(Value.Check(CODEX_PARAMS, { ...CODEX_ARGS, required: true })).toBe(true);
		expect(Value.Check(CLAUDE_PARAMS, { ...CLAUDE_ARGS, required: true })).toBe(true);
		expect(codex.required).toBe(true);
		expect(claude.required).toBe(true);
		expect("required" in toCanonical("codex", CODEX_ARGS)).toBe(false);
		expect(() => toCanonical("claude", { ...CLAUDE_ARGS, required: "yes" })).toThrow(AskUserSchemaError);
	});
});
