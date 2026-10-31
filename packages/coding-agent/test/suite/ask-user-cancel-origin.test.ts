// sisyphuslabs/omo-desktop-app#4042, senpi#4002 review: only a cancel the user chose, or a failing question UI,
// shows the model the answers given before it; a lifecycle cancel (turn abort, session close, ask-user disabled,
// a closed connection) stays silent.
import { expect, it } from "vitest";
import { formatModelAnswer } from "../../src/core/extensions/builtin/ask-user/format.ts";
import { emitSessionShutdownEvent } from "../../src/core/extensions/runner.ts";
import type { ExtensionContext, ExtensionToolContext, QuestionResponse } from "../../src/core/extensions/types.ts";
import { ConnectionQuestionBridge } from "../../src/modes/rpc/connection-question-bridge.ts";
import { createAskUserDelivery } from "./helpers/ask-user-delivery.ts";

const QUESTIONS = [
	{ id: "q1", header: "Auth", question: "Which flow?", options: [{ label: "A" }, { label: "B" }], multiSelect: false },
	{ id: "q2", header: "Library", question: "Which?", options: [{ label: "C" }, { label: "D" }], multiSelect: false },
];
const PARAMS = { questions: QUESTIONS.map(({ id: _id, ...question }) => question) };
const Q1 = { q1: { selected: ["A"] } };

type QuestionUi = NonNullable<ExtensionContext["ui"]["question"]>;

/** An async question whose UI reports q1 as progress, then stays open until `settle` ends it. */
async function openAsync(settle: (answer: PromiseWithResolvers<QuestionResponse>) => void, signal?: AbortSignal) {
	const delivery = await createAskUserDelivery();
	const answer = Promise.withResolvers<QuestionResponse>();
	const question: QuestionUi = (_request, opts) => {
		opts?.onProgress?.({ answers: Q1 });
		return answer.promise;
	};
	const ctx = delivery.context(question);
	await delivery.tool.execute(
		"async-q",
		{ ...PARAMS, waitForAnswer: false },
		signal,
		undefined,
		ctx as ExtensionToolContext,
	);
	const settled = delivery.settled(ctx, "async-q");
	settle(answer);
	return { delivery, settled };
}

it("an async question aborted with its turn after an answer sends no message", async () => {
	const turn = new AbortController();
	const { delivery, settled } = await openAsync(() => turn.abort(), turn.signal);
	expect((await settled).status).toBe("cancelled");
	expect(delivery.deliveries).toEqual([]);
});

it("an async question cancelled by the session closing after an answer sends no message", async () => {
	const { delivery, settled } = await openAsync(() => {});
	await emitSessionShutdownEvent(delivery.harness.getExtensionRunner(), { type: "session_shutdown", reason: "quit" });
	expect((await settled).status).toBe("cancelled");
	expect(delivery.deliveries).toEqual([]);
});

it("an async question cancelled because ask-user was disabled after an answer sends no message", async () => {
	const { delivery, settled } = await openAsync(() => {});
	delivery.harness.settingsManager.applyOverrides({ askUser: { enabled: false } });
	const model = delivery.harness.getModel();
	await delivery.harness.getExtensionRunner().emitModelSelect({
		type: "model_select",
		model,
		previousModel: model,
		source: "set",
		systemPrompt: "",
		systemPromptOptions: { cwd: delivery.harness.tempDir },
	});
	expect((await settled).status).toBe("cancelled");
	expect(delivery.deliveries).toEqual([]);
});

it("an async question the user cancelled after an answer delivers one message with it", async () => {
	const { delivery, settled } = await openAsync((answer) =>
		answer.resolve({ status: "cancelled", cancelOrigin: "user", answers: Q1, unanswered: ["q2"] }),
	);
	await settled;
	expect(delivery.deliveries.map((entry) => entry.content)).toEqual([
		"[Answer to question async-q]\nThe user cancelled the question after answering part of it.\nAuth: A\nUnanswered: Library",
	]);
});

it("an async question whose UI failed after an answer delivers the reason and the answer", async () => {
	const { delivery, settled } = await openAsync((answer) => answer.reject(new Error("boom")));
	await settled;
	expect(delivery.deliveries.map((entry) => entry.content)).toEqual([
		"[Answer to question async-q]\nQuestion UI failed: boom\nThe question was cancelled after part of it was answered.\nAuth: A\nUnanswered: Library",
	]);
});

it("a cancel the question UI reports without an origin stays a dismissal", () => {
	const response: QuestionResponse = { status: "cancelled", answers: Q1, unanswered: ["q2"] };
	expect(formatModelAnswer(response, "r", QUESTIONS).text).toBe("The user dismissed the question.");
});

it("marks an RPC client's cancel as the user's and a closed connection's as a lifecycle cancel", async () => {
	const request = { requestId: "r", waitForAnswer: true, timeoutMs: 60_000, questions: QUESTIONS };
	const bridge = new ConnectionQuestionBridge(() => {});
	const removed = bridge.ask(request);
	const id = bridge.pendingQuestions()[0]?.id ?? "";
	bridge.progress({ type: "extension_ui_progress", id, answers: Q1 });
	bridge.respond({ type: "extension_ui_response", id, cancelled: true });
	expect(await removed).toMatchObject({ status: "cancelled", cancelOrigin: "user", answers: Q1 });
	const closed = bridge.ask(request);
	bridge.cancelAll();
	expect((await closed).cancelOrigin).toBeUndefined();
});

it("lists several answers on their own lines when a question times out", () => {
	const response: QuestionResponse = {
		status: "timed_out",
		answers: { q1: { selected: ["A"] }, q2: { selected: ["C"] } },
		unanswered: [],
		autoResolvedAfterMs: 60_000,
	};
	expect(formatModelAnswer(response, "r", QUESTIONS).text).toBe(
		"The user did not answer within 1 minutes. (사용자가 답변을 안하고 timeout 으로 종료됨)\nBefore going idle the user had selected:\nAuth: A\nLibrary: C\nContinue the work to completion on your best judgment; do not ask this question again this turn.",
	);
});
