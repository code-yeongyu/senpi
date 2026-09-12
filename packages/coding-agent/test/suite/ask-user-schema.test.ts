import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	formatResultDetails,
	formatResultText,
	formatUserMessage,
} from "../../src/core/extensions/builtin/ask-user/format.ts";
import {
	AskUserSchemaError,
	type AskUserVariant,
	CLAUDE_PARAMS,
	CODEX_PARAMS,
	type QuestionRequest,
	type QuestionResponse,
	toCanonical,
} from "../../src/core/extensions/builtin/ask-user/schema.ts";

const WAIT_FLAG_STEER_TEXT =
	"This call omitted wait_for_answer (or waitForAnswer). Set true to pause here until the user answers, false to keep working and receive the answer later as a user message.";
const OPTIONS = [
	{ label: "OAuth (Recommended)", description: "Use OAuth 2.0 for user login." },
	{ label: "API keys", description: "Static keys in env." },
];
const CODEX_QUESTION = {
	id: "auth_method",
	header: "Auth method",
	question: "Which auth method should we use?",
	options: OPTIONS,
};
const CLAUDE_QUESTION = {
	header: "Auth method",
	question: "Which auth method should we use?",
	options: OPTIONS,
	multiSelect: false,
};
const QUESTIONS: QuestionRequest["questions"] = [
	{
		id: "q1",
		header: "Auth method",
		question: "Which auth method should we use?",
		options: OPTIONS,
		multiSelect: false,
	},
	{
		id: "q2",
		header: "Library",
		question: "Which library should we use?",
		options: [
			{ label: "date-fns", description: "Immutable helpers." },
			{ label: "Day.js", description: "Smaller runtime." },
		],
		multiSelect: false,
	},
];
const VARIANTS: AskUserVariant[] = ["codex", "claude"];
const TIMEOUT_KO = "(사용자가 답변을 안하고 timeout 으로 종료됨)";
const CONTINUE = "Continue the work to completion on your best judgment; do not ask this question again this turn.";

function expectSchemaError(run: () => unknown, expected: string | RegExp): void {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(AskUserSchemaError);
		if (error instanceof AskUserSchemaError) {
			if (typeof expected === "string") expect(error.message).toBe(expected);
			else expect(error.message).toMatch(expected);
		}
		return;
	}
	expect.fail("expected toCanonical to throw AskUserSchemaError");
}

function claudeArgs(questions: unknown[]): unknown {
	return { waitForAnswer: true, questions };
}

describe("ask-user schema", () => {
	it("(a) CODEX_PARAMS rejects a call missing wait_for_answer with the exact steer text", () => {
		const args = { questions: [CODEX_QUESTION] };
		expect(CODEX_PARAMS.required).toContain("wait_for_answer");
		expect(Value.Check(CODEX_PARAMS, args)).toBe(false);
		expectSchemaError(() => toCanonical("codex", args), WAIT_FLAG_STEER_TEXT);
	});

	it("(b) CLAUDE_PARAMS rejects missing waitForAnswer", () => {
		const args = { questions: [CLAUDE_QUESTION] };
		expect(CLAUDE_PARAMS.required).toContain("waitForAnswer");
		expect(Value.Check(CLAUDE_PARAMS, args)).toBe(false);
		expectSchemaError(() => toCanonical("claude", args), WAIT_FLAG_STEER_TEXT);
	});

	it("(c) 5 questions / 5 options / 1 option / empty header rejected; omitted options => []", () => {
		const option = { label: "Alpha", description: "First choice." };
		const optionB = { label: "Beta", description: "Second choice." };
		const question = { header: "Auth method", question: "Which auth method should we use?", multiSelect: false };
		expectSchemaError(
			() =>
				toCanonical(
					"claude",
					claudeArgs(Array.from({ length: 5 }, () => ({ ...question, options: [option, optionB] }))),
				),
			/1 to 4/,
		);
		expectSchemaError(
			() =>
				toCanonical("claude", claudeArgs([{ ...question, options: [option, optionB, option, optionB, option] }])),
			/2 to 4/,
		);
		expectSchemaError(
			() => toCanonical("claude", claudeArgs([{ ...question, options: [option] }])),
			/2 to 4|at least 2/,
		);
		expectSchemaError(
			() => toCanonical("claude", claudeArgs([{ ...question, header: "", options: [option, optionB] }])),
			/header/,
		);
		const canonical = toCanonical(
			"claude",
			claudeArgs([{ header: "Auth method", question: question.question, multiSelect: false }]),
		);
		expect(canonical.questions[0]?.options).toEqual([]);
	});

	it("(d) duplicate headers => distinct q1, q2", () => {
		const canonical = toCanonical(
			"claude",
			claudeArgs([
				{ header: "Auth", question: "Which auth method should we use?", options: OPTIONS, multiSelect: false },
				{ header: "Auth", question: "Where should tokens live?", options: OPTIONS, multiSelect: false },
			]),
		);
		expect(canonical.questions.map((question) => question.id)).toEqual(["q1", "q2"]);
		expect(canonical.questions.map((question) => question.header)).toEqual(["Auth", "Auth"]);
	});
});

describe("ask-user formatters", () => {
	const answered: QuestionResponse = {
		status: "answered",
		answers: { q1: { selected: ["OAuth (Recommended)"] }, q2: { selected: ["date-fns"] } },
		unanswered: [],
	};
	const answeredPartial: QuestionResponse = {
		status: "answered",
		answers: { q1: { selected: ["OAuth (Recommended)"] } },
		unanswered: ["q2"],
	};
	const commentSubmitted: QuestionResponse = {
		status: "comment-submitted",
		answers: { q1: { selected: ["OAuth (Recommended)"] } },
		comment: "just ship it",
		unanswered: ["q2"],
	};
	const timedOut: QuestionResponse = {
		status: "timed_out",
		answers: {},
		unanswered: ["q1", "q2"],
		autoResolvedAfterMs: 1_800_000,
	};
	const timedOutWithDraft: QuestionResponse = {
		status: "timed_out",
		answers: { q1: { selected: ["OAuth (Recommended)"] } },
		unanswered: ["q2"],
		autoResolvedAfterMs: 1_800_000,
	};
	const cancelled: QuestionResponse = { status: "cancelled", answers: {}, unanswered: ["q1", "q2"] };
	const orphaned: QuestionResponse = { status: "orphaned-after-restart", answers: {}, unanswered: ["q1", "q2"] };
	const unavailable: QuestionResponse = { status: "unavailable", answers: {}, unanswered: ["q1", "q2"] };
	const answeredText = "Auth method: OAuth (Recommended)\nLibrary: date-fns";
	const answeredPartialText = "Auth method: OAuth (Recommended)\nUnanswered: Library";
	const commentText = "The user responded: just ship it\nAuth method: OAuth (Recommended)\nUnanswered: Library";
	const timedOutText = `The user did not answer within 30 minutes. ${TIMEOUT_KO}\n${CONTINUE}`;
	const timedOutDraftText = `The user did not answer within 30 minutes. ${TIMEOUT_KO}\nBefore going idle the user had selected: Auth method: OAuth (Recommended)\n${CONTINUE}`;

	it("(e) formatter snapshots for all six statuses in both variants", () => {
		for (const variant of VARIANTS) {
			expect(formatResultText(variant, answered, QUESTIONS)).toBe(answeredText);
			expect(formatResultText(variant, answeredPartial, QUESTIONS)).toBe(answeredPartialText);
			expect(formatResultText(variant, commentSubmitted, QUESTIONS)).toBe(commentText);
			expect(formatResultText(variant, timedOut, QUESTIONS)).toBe(timedOutText);
			expect(formatResultText(variant, timedOutWithDraft, QUESTIONS)).toBe(timedOutDraftText);
			expect(formatResultText(variant, cancelled, QUESTIONS)).toBe("The user dismissed the question.");
			expect(formatResultText(variant, orphaned, QUESTIONS)).toBe(
				"The pending question could not be resumed after a restart; continue on best judgment.",
			);
			expect(formatResultText(variant, unavailable, QUESTIONS)).toBe(
				"This session has no user attached (subagent or headless); decide on best judgment.",
			);
		}
		expect(formatResultText("claude", timedOut, QUESTIONS)).toContain(TIMEOUT_KO);
		expect(formatUserMessage(answered, "req-1", QUESTIONS)).toBe(`[Answer to question req-1]\n${answeredText}`);
	});

	it("(f) multi-select Claude answer joined by ', ', codex answer array", () => {
		const questions: QuestionRequest["questions"] = [
			{
				id: "q1",
				header: "Features",
				question: "Which features do you want to enable?",
				options: [{ label: "OAuth" }, { label: "API keys" }, { label: "SSO" }],
				multiSelect: true,
			},
		];
		const response: QuestionResponse = {
			status: "answered",
			answers: { q1: { selected: ["OAuth", "API keys"] } },
			unanswered: [],
		};
		const claude = formatResultDetails("claude", response, questions);
		expect("questions" in claude).toBe(true);
		if ("questions" in claude) {
			expect(claude.answers["Which features do you want to enable?"]).toBe("OAuth, API keys");
		}
		const codex = formatResultDetails("codex", response, questions);
		expect("questions" in codex).toBe(false);
		if (!("questions" in codex)) {
			expect(codex.answers.q1).toEqual({ answers: ["OAuth", "API keys"] });
		}
	});
});
