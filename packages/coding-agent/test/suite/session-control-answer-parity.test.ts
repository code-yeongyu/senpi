/**
 * One `extension_ui_response` frame answering an async question must reach the model as the same
 * framed user message whether a multi-session host or a terminal control endpoint settles it. Both
 * surfaces run the real ask-user tool; only the question bridge differs: the host's
 * `ConnectionQuestionBridge`, or a terminal surface that holds pending questions the way the
 * interactive TUI does.
 */
import { afterEach, describe, expect, it } from "vitest";
import type {
	ExtensionContext,
	ExtensionToolContext,
	QuestionRequest,
	QuestionResponse,
} from "../../src/core/extensions/types.ts";
import type { TuiControlSurface } from "../../src/modes/interactive/session-control-commands.ts";
import { ConnectionQuestionBridge } from "../../src/modes/rpc/connection-question-bridge.ts";
import { settleExtensionUiResponse } from "../../src/modes/rpc/extension-ui-response.ts";
import type { RpcExtensionUIResponse, RpcQuestionAnswers } from "../../src/modes/rpc/rpc-types.ts";
import { controlRequest } from "../helpers/session-control-client.ts";
import { type EndpointFixture, startEndpoint } from "../helpers/session-control-fixture.ts";
import { ASYNC_QUESTIONS, type AskUserDelivery, createAskUserDelivery } from "./helpers/ask-user-delivery.ts";

const REQUEST_ID = "ask-1";
const deliveries: AskUserDelivery[] = [];
const endpoints: EndpointFixture[] = [];

afterEach(async () => {
	for (const fixture of endpoints.splice(0)) {
		await fixture.endpoint.dispose();
		fixture.harness.cleanup();
	}
	for (const delivery of deliveries.splice(0)) delivery.harness.cleanup();
});

type Frame = (uiRequestId: string) => RpcExtensionUIResponse;
type Body = {
	readonly answers: RpcQuestionAnswers;
	readonly comment?: string;
	readonly value?: string;
	readonly confirmed?: boolean;
};

interface Outcome {
	readonly reply: Readonly<Record<string, unknown>>;
	/** What the model receives: every user message the ask-user tool delivered. */
	readonly delivered: unknown[];
	readonly pending: boolean;
}

type AskedQuestions = ReadonlyArray<{
	readonly header: string;
	readonly question: string;
	readonly multiSelect: boolean;
}>;

async function askAsync(
	delivery: AskUserDelivery,
	ctx: ExtensionContext,
	questions: AskedQuestions,
): Promise<{ readonly settled: Promise<QuestionResponse> }> {
	await delivery.tool.execute(
		REQUEST_ID,
		{ questions, waitForAnswer: false },
		undefined,
		undefined,
		ctx as ExtensionToolContext,
	);
	return { settled: delivery.settled(ctx, REQUEST_ID) };
}

async function answerOnHost(frame: Frame, questions: AskedQuestions = ASYNC_QUESTIONS): Promise<Outcome> {
	const delivery = await createAskUserDelivery();
	deliveries.push(delivery);
	const bridge = new ConnectionQuestionBridge(() => {});
	const { settled } = await askAsync(
		delivery,
		delivery.context((request, opts) => bridge.ask(request, opts)),
		questions,
	);
	const uiRequestId = bridge.pendingQuestions()[0]?.id;
	if (uiRequestId === undefined) throw new Error("the host bridge has no pending question");
	const reply = settleExtensionUiResponse(frame(uiRequestId), {
		questions: bridge,
		dialogs: { resolve: () => false },
		routed: true,
	});
	if (reply === undefined) throw new Error("a routed host connection must reply");
	const pending = bridge.pendingQuestions().length > 0;
	if (!pending) await settled;
	return { reply, delivered: delivery.deliveries.map((entry) => entry.content), pending };
}

async function answerOnTerminal(frame: Frame, questions: AskedQuestions = ASYNC_QUESTIONS): Promise<Outcome> {
	const delivery = await createAskUserDelivery();
	deliveries.push(delivery);
	const pending = new Map<string, { request: QuestionRequest; finish: (response: QuestionResponse) => void }>();
	const surface: Pick<TuiControlSurface, "pendingQuestionIds" | "pendingQuestion" | "answerQuestion"> = {
		pendingQuestionIds: () => [...pending.keys()],
		pendingQuestion: (requestId) => pending.get(requestId)?.request,
		answerQuestion: (requestId, response) => {
			const state = pending.get(requestId);
			state?.finish(response);
			return state !== undefined;
		},
	};
	const fixture = await startEndpoint({ harness: delivery.harness, questions: surface });
	endpoints.push(fixture);
	const { settled } = await askAsync(
		delivery,
		delivery.context(
			(request) =>
				new Promise<QuestionResponse>((resolve) => {
					pending.set(request.requestId, {
						request,
						finish: (response) => {
							pending.delete(request.requestId);
							resolve(response);
						},
					});
				}),
		),
		questions,
	);
	const reply = await controlRequest(fixture.socket, frame(REQUEST_ID));
	if (reply.kind !== "answered") throw new Error("the terminal control socket closed without a reply");
	const stillPending = pending.has(REQUEST_ID);
	if (!stillPending) await settled;
	return { reply: reply.record, delivered: delivery.deliveries.map((entry) => entry.content), pending: stillPending };
}

/** The combined text frame omo's relay sends for a question reported without a kind. */
const combined = (text: string): Body => ({ value: text, answers: {}, comment: text });

const ANSWERED: ReadonlyArray<{ readonly name: string; readonly body: Body; readonly model: string }> = [
	{
		name: "the combined text frame (value + answers:{} + comment)",
		body: combined("ship it"),
		model: "[Answer to question ask-1]\nThe user responded: ship it\nUnanswered: Library",
	},
	{
		name: "the combined text frame with a yes/no confirmed",
		body: { ...combined("yes"), confirmed: true },
		model: "[Answer to question ask-1]\nThe user responded: yes\nUnanswered: Library",
	},
	{
		name: "a comment-only question frame",
		body: { answers: {}, comment: "ship it" },
		model: "[Answer to question ask-1]\nThe user responded: ship it\nUnanswered: Library",
	},
	{
		name: "a structured answer",
		body: { answers: { q1: { selected: ["OAuth"] } } },
		model: "[Answer to question ask-1]\nLibrary: OAuth",
	},
	{
		name: "a structured answer with a comment",
		body: { answers: { q1: { selected: ["OAuth"] } }, comment: "and cache it" },
		model: "[Answer to question ask-1]\nThe user responded: and cache it\nLibrary: OAuth",
	},
];

describe("one extension_ui_response frame, host and terminal", () => {
	for (const { name, body, model } of ANSWERED) {
		it(`delivers ${name} to the model identically, under the frame id`, async () => {
			const host = await answerOnHost((uiRequestId) => ({
				type: "extension_ui_response",
				id: "answer-1",
				uiRequestId,
				...body,
			}));
			const terminal = await answerOnTerminal((uiRequestId) => ({
				type: "extension_ui_response",
				id: "answer-1",
				uiRequestId,
				...body,
			}));

			for (const outcome of [host, terminal]) {
				expect(outcome.reply).toMatchObject({ id: "answer-1", command: "extension_ui_response", success: true });
				expect(outcome.delivered).toEqual([model]);
				expect(outcome.pending).toBe(false);
			}
		});
	}

	it("delivers the short form (id names the request, no uiRequestId) identically", async () => {
		const host = await answerOnHost((uiRequestId) => ({
			type: "extension_ui_response",
			id: uiRequestId,
			...combined("ship it"),
		}));
		const terminal = await answerOnTerminal((uiRequestId) => ({
			type: "extension_ui_response",
			id: uiRequestId,
			...combined("ship it"),
		}));

		for (const outcome of [host, terminal]) {
			expect(outcome.reply).toMatchObject({ success: true });
			expect(outcome.delivered).toEqual([
				"[Answer to question ask-1]\nThe user responded: ship it\nUnanswered: Library",
			]);
		}
	});

	it("refuses a frame with neither answers nor a comment as question_incomplete and keeps the question pending", async () => {
		const blank: Body = { value: " ", answers: {}, comment: " " };
		const host = await answerOnHost((uiRequestId) => ({
			type: "extension_ui_response",
			id: "answer-1",
			uiRequestId,
			...blank,
		}));
		const terminal = await answerOnTerminal((uiRequestId) => ({
			type: "extension_ui_response",
			id: "answer-1",
			uiRequestId,
			...blank,
		}));

		for (const outcome of [host, terminal]) {
			expect(outcome.reply).toMatchObject({ id: "answer-1", success: false, error: "question_incomplete" });
			expect(outcome.delivered).toEqual([]);
			expect(outcome.pending).toBe(true);
		}
	});
});

const THREE_QUESTIONS: AskedQuestions = [
	{ header: "Library", question: "Which library?", multiSelect: false },
	{ header: "Cache", question: "Which cache?", multiSelect: false },
	{ header: "Deploy", question: "When to deploy?", multiSelect: false },
];

const MULTI: ReadonlyArray<{ readonly name: string; readonly body: Frame; readonly model: readonly string[] }> = [
	{
		name: "a partial answer: one selected, one blank entry, one text-only",
		body: (uiRequestId) => ({
			type: "extension_ui_response",
			id: "answer-1",
			uiRequestId,
			answers: { q1: { selected: ["OAuth"] }, q2: { selected: [] }, q3: { selected: [], text: "nightly" } },
		}),
		model: ["[Answer to question ask-1]\nLibrary: OAuth\nDeploy: nightly\nUnanswered: Cache"],
	},
	{
		name: "the combined text frame with confirmed: false",
		body: (uiRequestId) => ({
			type: "extension_ui_response",
			id: "answer-1",
			uiRequestId,
			...combined("ship it"),
			confirmed: false,
		}),
		model: ["[Answer to question ask-1]\nThe user responded: ship it\nUnanswered: Library, Cache, Deploy"],
	},
	{
		name: "a cancel",
		body: (uiRequestId) => ({ type: "extension_ui_response", id: "answer-1", uiRequestId, cancelled: true }),
		model: [],
	},
];

describe("one extension_ui_response frame to a three-question request, host and terminal", () => {
	for (const { name, body, model } of MULTI) {
		it(`settles ${name} identically, with the unanswered headers`, async () => {
			const host = await answerOnHost(body, THREE_QUESTIONS);
			const terminal = await answerOnTerminal(body, THREE_QUESTIONS);

			for (const outcome of [host, terminal]) {
				expect(outcome.reply).toMatchObject({ id: "answer-1", command: "extension_ui_response", success: true });
				expect(outcome.delivered).toEqual(model);
				expect(outcome.pending).toBe(false);
			}
		});
	}
});
