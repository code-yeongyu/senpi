import { afterEach, describe, expect, it, vi } from "vitest";
import { getPendingQuestions } from "../../src/core/extensions/builtin/ask-user/registry.ts";
import type { QuestionResponse } from "../../src/core/extensions/builtin/ask-user/schema.ts";
import { emitSessionShutdownEvent } from "../../src/core/extensions/runner.ts";
import type { ExtensionContext, ExtensionToolContext } from "../../src/core/extensions/types.ts";
import { ASYNC_QUESTIONS, type AskUserDelivery, createAskUserDelivery } from "./helpers/ask-user-delivery.ts";

const deliveries: AskUserDelivery[] = [];
afterEach(() => {
	for (const delivery of deliveries.splice(0)) {
		for (const entry of getPendingQuestions(delivery.harness.session.sessionManager.getSessionId())) entry.cancel();
		delivery.harness.cleanup();
	}
	vi.useRealTimers();
});

// Regression: #1857. The UI reset resolves the old bridge during a reload.
describe("ask-user reload", () => {
	it("preserves each pending request and draft with one reattachment and its original deadline", async () => {
		const delivery = await createAskUserDelivery();
		deliveries.push(delivery);
		vi.useFakeTimers();
		const oldResponse = Promise.withResolvers<QuestionResponse>();
		const question = vi.fn<NonNullable<ExtensionContext["ui"]["question"]>>(() => oldResponse.promise);
		const context = delivery.context(question);
		const runner = delivery.harness.getExtensionRunner();
		runner.setUIContext(context.ui, "tui");
		await delivery.tool.execute(
			"reload-question",
			{ questions: ASYNC_QUESTIONS, waitForAnswer: false },
			undefined,
			undefined,
			context as ExtensionToolContext,
		);
		const entry = getPendingQuestions(context.sessionManager.getSessionId())[0];
		if (!entry) throw new Error("missing pending question");
		const options = question.mock.calls[0]?.[1];
		const draft = {
			answers: { q1: { selected: ["A"], text: "draft" } },
			comment: "not finished",
		};
		options?.onProgress?.(draft);
		const deadline = entry.pending.deadlineAtMs;
		await emitSessionShutdownEvent(runner, {
			type: "session_shutdown",
			reason: "reload",
		});
		oldResponse.resolve({
			status: "cancelled",
			answers: {},
			unanswered: ["q1"],
		});
		await oldResponse.promise;
		expect(getPendingQuestions(context.sessionManager.getSessionId())).toEqual([entry]);
		await vi.advanceTimersByTimeAsync(5_000);
		const newResponse = Promise.withResolvers<QuestionResponse>();
		const reattached = vi.fn(() => newResponse.promise);
		runner.setUIContext({ ...context.ui, question: reattached }, "tui");
		await runner.emit({ type: "session_start", reason: "reload" });
		await runner.emit({ type: "session_start", reason: "reload" });
		expect(reattached).toHaveBeenCalledTimes(1);
		expect(reattached).toHaveBeenCalledWith(
			entry.request,
			expect.objectContaining({
				initialDraft: draft,
				timeout: deadline - Date.now(),
			}),
		);
		expect(entry.pending.deadlineAtMs).toBe(deadline);
		expect(delivery.deliveries).toEqual([]);
		expect(
			context.sessionManager
				.getBranch()
				.filter((item) => item.type === "custom" && item.customType === "ask-user:question"),
		).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(deadline - Date.now());
		await expect(entry.completion).resolves.toMatchObject({
			status: "timed_out",
			...draft,
		});
		newResponse.resolve({
			status: "answered",
			answers: draft.answers,
			unanswered: [],
		});
		await newResponse.promise;
		expect(delivery.deliveries).toHaveLength(1);
	});

	it("keeps a genuine session close silent", async () => {
		const delivery = await createAskUserDelivery();
		deliveries.push(delivery);
		const context = delivery.context(() => new Promise(() => {}));
		const runner = delivery.harness.getExtensionRunner();
		runner.setUIContext(context.ui, "tui");
		await delivery.tool.execute(
			"close-question",
			{ questions: ASYNC_QUESTIONS, waitForAnswer: false },
			undefined,
			undefined,
			context as ExtensionToolContext,
		);
		const completion = delivery.settled(context, "close-question");
		await emitSessionShutdownEvent(runner, {
			type: "session_shutdown",
			reason: "quit",
		});
		await expect(completion).resolves.toMatchObject({ status: "cancelled" });
		expect(getPendingQuestions(context.sessionManager.getSessionId())).toEqual([]);
		expect(delivery.deliveries).toEqual([]);
	});

	it("delivers through the replacement runner after an actual session reload", async () => {
		const delivery = await createAskUserDelivery();
		deliveries.push(delivery);
		const answers = [Promise.withResolvers<QuestionResponse>(), Promise.withResolvers<QuestionResponse>()];
		let attachment = 0;
		const question = vi.fn<NonNullable<ExtensionContext["ui"]["question"]>>((_request, options) => {
			const response = answers[attachment++];
			if (!response) throw new Error("duplicate attachment");
			options?.signal?.addEventListener(
				"abort",
				() => {
					response.resolve({
						status: "cancelled",
						answers: {},
						unanswered: ["q1"],
					});
				},
				{ once: true },
			);
			return response.promise;
		});
		const context = delivery.context(question);
		await delivery.harness.session.bindExtensions({
			uiContext: context.ui,
			mode: "tui",
		});
		await delivery.tool.execute(
			"runner-swap",
			{ questions: ASYNC_QUESTIONS, waitForAnswer: false },
			undefined,
			undefined,
			context as ExtensionToolContext,
		);
		const completion = delivery.settled(context, "runner-swap");
		const oldRunner = delivery.harness.getExtensionRunner();
		await delivery.harness.session.reload();
		expect(oldRunner.isActive).toBe(false);
		expect(question).toHaveBeenCalledTimes(2);
		expect(delivery.deliveries).toEqual([]);
		answers[1].resolve({
			status: "answered",
			answers: { q1: { selected: ["A"] } },
			unanswered: [],
		});
		await completion;
		expect(delivery.deliveries).toHaveLength(1);
	});

	it("reports a lost pending question through the new runner when reload disables ask-user", async () => {
		const delivery = await createAskUserDelivery();
		deliveries.push(delivery);
		const question = vi.fn(() => new Promise<QuestionResponse>(() => {}));
		const context = delivery.context(question);
		await delivery.harness.session.bindExtensions({
			uiContext: context.ui,
			mode: "tui",
		});
		await delivery.tool.execute(
			"disable-reload",
			{ questions: ASYNC_QUESTIONS, waitForAnswer: false },
			undefined,
			undefined,
			context as ExtensionToolContext,
		);
		const completion = delivery.settled(context, "disable-reload");
		const errors: unknown[] = [];
		await delivery.harness.session.bindExtensions({
			onError: (error) => errors.push(error),
		});
		await delivery.harness.session.reload({
			beforeSessionStart: () =>
				delivery.harness.settingsManager.applyOverrides({
					askUser: { enabled: false },
				}),
		});
		expect(errors).toEqual([]);
		await expect(completion).resolves.toMatchObject({
			status: "orphaned-after-restart",
		});
		expect(delivery.deliveries).toHaveLength(1);
		expect(question).toHaveBeenCalledTimes(1);
		expect(delivery.harness.session.getActiveToolNames()).not.toContain("ask_user_question");
	});

	it("terminates at the idle deadline without session_start and reports the queued outcome on the next binding", async () => {
		const delivery = await createAskUserDelivery(1);
		deliveries.push(delivery);
		vi.useFakeTimers();
		const context = delivery.context(() => new Promise(() => {}));
		const notify = vi.fn();
		context.ui.notify = notify;
		const runner = delivery.harness.getExtensionRunner();
		runner.setUIContext(context.ui, "tui");
		await delivery.tool.execute(
			"detached-timeout",
			{ questions: ASYNC_QUESTIONS, waitForAnswer: false },
			undefined,
			undefined,
			context as ExtensionToolContext,
		);
		const completion = delivery.settled(context, "detached-timeout");
		const terminal = vi.fn();
		void completion.then(terminal);
		await emitSessionShutdownEvent(runner, {
			type: "session_shutdown",
			reason: "reload",
		});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(terminal).toHaveBeenCalledWith(expect.objectContaining({ status: "timed_out" }));
		expect(getPendingQuestions(context.sessionManager.getSessionId())).toEqual([]);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(delivery.deliveries).toEqual([]);
		await runner.emit({ type: "session_start", reason: "reload" });
		await runner.emit({ type: "session_start", reason: "reload" });
		expect(delivery.deliveries).toHaveLength(1);
	});
});
