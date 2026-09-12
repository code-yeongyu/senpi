import { describe, expect, it } from "vitest";
import { QUESTION_CAPABILITY } from "../../src/modes/rpc/custom-capability.ts";
import type {
	RpcExtensionUIProgress,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcInboundRecord,
	RpcQuestionResolvedEvent,
	RpcQuestionUpdatedEvent,
	RpcSessionState,
} from "../../src/modes/rpc/rpc-types.ts";

type QuestionUiRequest = Extract<RpcExtensionUIRequest, { method: "question" }>;
type QuestionUiResponse = Extract<RpcExtensionUIResponse, { answers: RpcQuestionResolvedEvent["answers"] }>;
type WaitOptional = Partial<Pick<QuestionUiRequest, "waitForAnswer">> & Omit<QuestionUiRequest, "waitForAnswer">;
type MissingWaitAssignable = WaitOptional extends RpcExtensionUIRequest ? true : false;

const questionRequest = {
	type: "extension_ui_request",
	id: "ui-1",
	method: "question",
	requestId: "req-1",
	toolCallId: "call-1",
	waitForAnswer: true,
	questions: [
		{
			id: "q1",
			header: "Auth",
			question: "Which auth method?",
			options: [{ label: "OAuth", description: "Browser login" }, { label: "API key" }],
			multiSelect: false,
		},
	],
	timeout: 1_800_000,
	askedAtMs: 1_000,
	deadlineAtMs: 1_801_000,
	remainingMs: 1_800_000,
} satisfies QuestionUiRequest;

const questionResponse = {
	type: "extension_ui_response",
	id: "ui-1",
	answers: { q1: { selected: ["OAuth"], text: "prefer oauth" } },
	comment: "ship it",
} satisfies QuestionUiResponse;

const questionProgress = {
	type: "extension_ui_progress",
	id: "ui-1",
	answers: { q1: { selected: ["OAuth"] } },
	comment: "draft",
	sessionId: "sess-1",
} satisfies RpcExtensionUIProgress;

const questionUpdated = {
	type: "question_updated",
	id: "ui-1",
	deadlineAtMs: 1_801_000,
	remainingMs: 1_200_000,
} satisfies RpcQuestionUpdatedEvent;

const questionResolved = {
	type: "question_resolved",
	id: "ui-1",
	requestId: "req-1",
	toolCallId: "call-1",
	outcome: "comment-submitted",
	answers: { q1: { selected: ["OAuth"] } },
	comment: "ship it",
	unanswered: [],
	deadlineAtMs: 1_801_000,
} satisfies RpcQuestionResolvedEvent;

describe("rpc question wire types", () => {
	it("exports QUESTION_CAPABILITY as question", () => {
		expect(QUESTION_CAPABILITY).toBe("question");
	});

	it("accepts a question extension_ui_request literal", () => {
		const record: RpcExtensionUIRequest = questionRequest;
		expect(record).toMatchObject({
			type: "extension_ui_request",
			method: "question",
			requestId: "req-1",
			toolCallId: "call-1",
			waitForAnswer: true,
		});
		expect(questionRequest.questions[0]?.options[0]?.label).toBe("OAuth");
	});

	it("accepts an answers/comment extension_ui_response literal", () => {
		const record: RpcExtensionUIResponse = questionResponse;
		expect(record).toEqual(questionResponse);
		expect(questionResponse.answers.q1?.selected).toEqual(["OAuth"]);
	});

	it("accepts extension_ui_progress on the inbound record union", () => {
		const inbound: RpcInboundRecord = questionProgress;
		expect(inbound).toEqual(questionProgress);
		expect(questionProgress.type).toBe("extension_ui_progress");
	});

	it("accepts question_updated and question_resolved outbound literals", () => {
		expect(questionUpdated.type).toBe("question_updated");
		expect(questionResolved.outcome).toBe("comment-submitted");
		expect(questionResolved.unanswered).toEqual([]);
	});

	it("hydrates RpcSessionState.pendingQuestions with the question request body", () => {
		const pending: NonNullable<RpcSessionState["pendingQuestions"]> = [questionRequest];
		expect(pending[0]?.method).toBe("question");
		expect(pending[0]?.waitForAnswer).toBe(true);
	});

	it("rejects a question request that omits waitForAnswer at the type level", () => {
		const missingWaitIsRejected: MissingWaitAssignable = false;
		expect(missingWaitIsRejected).toBe(false);
	});
});
