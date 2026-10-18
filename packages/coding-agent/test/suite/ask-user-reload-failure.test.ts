import { afterEach, expect, it, vi } from "vitest";
import { formatUserMessage } from "../../src/core/extensions/builtin/ask-user/format.ts";
import { getPendingQuestions } from "../../src/core/extensions/builtin/ask-user/registry.ts";
import { emitSessionShutdownEvent } from "../../src/core/extensions/runner.ts";
import type { ExtensionContext, ExtensionToolContext } from "../../src/core/extensions/types.ts";
import { ASYNC_QUESTIONS, type AskUserDelivery, createAskUserDelivery } from "./helpers/ask-user-delivery.ts";

const deliveries: AskUserDelivery[] = [];
afterEach(() => {
	for (const delivery of deliveries.splice(0)) {
		for (const entry of getPendingQuestions(delivery.harness.sessionManager.getSessionId())) entry.cancel();
		delivery.harness.cleanup();
	}
});

// #1857: a failed reattachment must terminate visibly, never as a silent cancel.
it.each(["missing", "throw", "reject"] as const)(
	"delivers one framed outcome and TUI notice when the reload bridge is %s",
	async (failure) => {
		const delivery = await createAskUserDelivery();
		deliveries.push(delivery);
		const context = delivery.context(() => new Promise(() => {}));
		const runner = delivery.harness.getExtensionRunner();
		runner.setUIContext(context.ui, "tui");
		await delivery.tool.execute(
			"failure-question",
			{ questions: ASYNC_QUESTIONS, waitForAnswer: false },
			undefined,
			undefined,
			context as ExtensionToolContext,
		);
		const entry = getPendingQuestions(context.sessionManager.getSessionId())[0];
		if (!entry) throw new Error("missing pending question");
		await emitSessionShutdownEvent(runner, {
			type: "session_shutdown",
			reason: "reload",
		});
		const notify = vi.fn();
		const question: ExtensionContext["ui"]["question"] =
			failure === "missing"
				? undefined
				: () => {
						if (failure === "throw") throw new Error("bridge failed");
						return Promise.reject(new Error("bridge failed"));
					};
		runner.setUIContext({ ...context.ui, question, notify }, "tui");
		await runner.emit({ type: "session_start", reason: "reload" });
		const response = await entry.completion;
		await runner.emit({ type: "session_start", reason: "reload" });
		expect(response.status).toBe("orphaned-after-restart");
		expect(delivery.deliveries).toEqual([
			{
				content: formatUserMessage(response, entry.request.requestId, entry.request.questions),
				options: { deliverAs: "followUp" },
			},
		]);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(expect.any(String), "error");
		expect(getPendingQuestions(context.sessionManager.getSessionId())).toEqual([]);
	},
);
